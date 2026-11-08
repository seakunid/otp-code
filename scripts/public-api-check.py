"""Public Funnel checks. Existing key stays in environment; responses are never logged."""
import argparse
import http.client
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import time
import uuid

HOST = 'windows.tailb37f08.ts.net'
ACCOUNTS = ['nebula.together@gmail.com', 'abbyfc.dev@gmail.com']
parser = argparse.ArgumentParser()
parser.add_argument('--ingress', required=True, help='Public DNS A record; bypasses MagicDNS, retains TLS SNI')
parser.add_argument('--gmail', action='store_true', help='Requires isolated playground host, never production activation')
args = parser.parse_args()
assert ipaddress.ip_address(args.ingress).is_global, 'Public ingress required'
token = os.environ['OTP_RETRIEVAL_TOKEN']
report = {'host': HOST, 'publicIngress': args.ingress, 'tlsVerified': True, 'cases': []}
output = Path('artifacts/public-gmail-check.json' if args.gmail else 'artifacts/public-api-check.json')
output.parent.mkdir(exist_ok=True)

class PublicHTTPS(http.client.HTTPSConnection):
    def connect(self):
        self.sock = self._context.wrap_socket(socket.create_connection((args.ingress, 443), self.timeout), server_hostname=HOST)

def call(method, path, body=None, key=token, attempt=None):
    connection = PublicHTTPS(HOST, timeout=75, context=ssl.create_default_context())
    headers = {'Content-Type': 'application/json'}
    if key is not None:
        headers['Authorization'] = 'Bearer ' + key
    if attempt:
        headers['Idempotency-Key'] = attempt
    try:
        connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()

def check(name, action):
    start = time.monotonic()
    try:
        action()
    except Exception as error:
        report['cases'].append({'name': name, 'status': 'FAIL', 'errorType': type(error).__name__})
        output.write_text(json.dumps(report, indent=2))
        raise SystemExit('FAIL: ' + name) from None
    report['cases'].append({'name': name, 'status': 'PASS', 'elapsedMs': round((time.monotonic()-start)*1000)})
    output.write_text(json.dumps(report, indent=2))
    print('PASS: ' + name, flush=True)

def expect(status, result):
    assert result[0] == status, 'Unexpected HTTP status'
    return result[1]

rule = {'providerUid': 'public-preview', 'purpose': 'LOGIN', 'version': 1,
        'senders': [ACCOUNTS[0]], 'subjectMode': 'exact', 'subject': 'OTP-E2E-preview',
        'purposeMarkers': ['sign-in code'], 'pattern': r'code is (?<otp>[0-9]{6})'}
if not args.gmail:
    routes = [('GET', '/health/live'), ('GET', '/health/ready'), ('GET', '/v1/profiles'),
              ('GET', '/v1/profiles/unknown'), ('POST', '/v1/profiles/unknown/setup'),
              ('POST', '/v1/lookups'), ('POST', '/v1/lookups/unknown/cancel'),
              ('POST', '/v1/rules/validate'), ('POST', '/v1/rules/preview'),
              ('PUT', '/v1/providers/unknown/rules/LOGIN/versions/1'),
              ('GET', '/v1/providers/unknown/rules/LOGIN'),
              ('POST', '/v1/providers/unknown/rules/LOGIN/versions/1/verify'),
              ('POST', '/v1/providers/unknown/rules/LOGIN/activate'),
              ('POST', '/v1/providers/unknown/rules/LOGIN/deactivate')]
    for method, path in routes:
        for key, name in [(None, 'missing'), ('wrong-shared-key', 'wrong')]:
            check(name+' key '+method+' '+path, lambda m=method,p=path,k=key: expect(401, call(m,p,{},k)))
    check('authenticated liveness', lambda: expect(200, call('GET','/health/live')))
    check('authenticated readiness', lambda: expect(200, call('GET','/health/ready')))
    check('authenticated profiles', lambda: expect(200, call('GET','/v1/profiles?limit=2')))
    check('rule validation', lambda: expect(200, call('POST','/v1/rules/validate',rule)))
    def preview():
        data=expect(200,call('POST','/v1/rules/preview',{'rule':rule,'message':{'sender':ACCOUNTS[0],'subject':rule['subject'],'body':'Your sign-in code is 073821.'}}))
        assert data['outcome']=='FOUND' and data['code']=='073821'
    check('rule preview exact code',preview)
    for path in ['/v1/lookups','/v1/lookups/unknown/cancel','/v1/profiles/unknown/setup']:
        check('malformed '+path,lambda p=path: expect(422,call('POST',p,{'unexpected':True})))
else:
    assert os.environ.get('OTP_REAL_GMAIL_E2E')=='true', 'Explicit real Gmail opt-in required'
    run='OTP-E2E-public-'+str(int(time.time()))
    report['run']=run
    for sender in [0,1]:
        target=1-sender
        def roundtrip():
            subject=run+'-'+str(sender)
            current={**rule,'providerUid':subject,'senders':[ACCOUNTS[sender]],'subjectMode':'contains','subject':subject}
            path='/v1/providers/'+subject+'/rules/LOGIN'
            expect(200,call('PUT',path+'/versions/1',current))
            # Only this explicitly isolated playground may accept synthetic proof.
            start=int(time.time())-2
            env={**os.environ,'OTP_E2E_WINDOWS_SUBJECT':subject,'OTP_E2E_WINDOWS_SENDER_INDEX':str(sender)}
            subprocess.run(['python3','scripts/windows-e2e-send.py','verify'],env=env,check=True,timeout=150,capture_output=True)
            attempt=str(uuid.uuid4())
            request={'requestUid':attempt,'attemptUid':attempt,'providerUid':subject,'accountUid':'playground-'+str(target),
                     'targetEmail':ACCOUNTS[target],'purpose':'LOGIN','ruleVersion':1,'windowStartedAt':start,
                     'lookupDeadlineAt':int(time.time())+60,'otpValiditySeconds':300,'excludedSourceMessageRefs':[]}
            proof=expect(200,call('POST',path+'/versions/1/verify',request))
            assert proof['verificationKind']=='SYNTHETIC'
            expect(200,call('POST',path+'/activate',{'version':1,'commandUid':str(uuid.uuid4()),'expectedActiveRevision':0}))
            try:
                # Diagnostic verification does not consume this source; reuse the single tagged email.
                attempt=str(uuid.uuid4())
                request.update(requestUid=attempt,attemptUid=attempt,lookupDeadlineAt=int(time.time())+60)
                result=expect(200,call('POST','/v1/lookups',request,attempt=attempt))
                assert result['outcome']=='FOUND' and result['code']=='073821'
                assert result['targetEmail']==ACCOUNTS[target] and result['attemptUid']==attempt
                assert result['receivedAt']>=start and result['expiresAt']>int(time.time())
                replay=expect(200,call('POST','/v1/lookups',request,attempt=attempt))
                assert replay['replayed'] and replay['sourceMessageRef']==result['sourceMessageRef'] and replay['code']==result['code']
                health=expect(200,call('GET','/health/ready'))
                assert health['active']==0 and health['quarantined']==0
            finally:
                expect(200,call('POST',path+'/deactivate',{'version':1,'commandUid':str(uuid.uuid4()),'expectedActiveRevision':1}))
        check('real public Gmail retrieval and replay: '+ACCOUNTS[target],roundtrip)
