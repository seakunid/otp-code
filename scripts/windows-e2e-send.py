"""Opt-in cross-account synthetic sender. No production send endpoint or mail credentials."""
import base64,json,os,pathlib,subprocess,sys,time
if os.environ.get('OTP_REAL_GMAIL_E2E')!='true':
    raise SystemExit('Explicit real Gmail E2E opt-in required')
subject=os.environ['OTP_E2E_WINDOWS_SUBJECT']+'-'+sys.argv[1]
from_index=int(os.environ['OTP_E2E_WINDOWS_SENDER_INDEX'])
if from_index not in (0,1) or not subject.startswith('OTP-E2E-'):
    raise SystemExit('Invalid synthetic fixture')
payload=json.dumps({'from':from_index,'to':1-from_index,'subject':subject,'body':'Your sign-in code is 073821. Do not share this synthetic test code.'})
def ps(script):
    encoded=base64.b64encode(("$ErrorActionPreference='Stop';"+script).encode('utf-16le')).decode()
    return subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=12','rizky-office-windows','powershell -NoProfile -EncodedCommand '+encoded],capture_output=True,text=True,timeout=30)
encoded_payload=base64.b64encode(payload.encode()).decode()
root="C:\\Users\\nebula\\Desktop\\otp_automation"
result=ps("$r='"+root+"';[IO.File]::WriteAllText($r+'\\runtime\\gmail-send.json',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded_payload+"')));Remove-Item ($r+'\\runtime\\gmail-send-result.json') -ErrorAction SilentlyContinue;Start-ScheduledTask OTP-System-Gmail-Send")
if result.returncode:raise SystemExit('Could not start synthetic sender')
for _ in range(120):
    time.sleep(1)
    result=ps("$p='"+root+"\\runtime\\gmail-send-result.json';if(Test-Path $p){Get-Content $p}")
    try:report=json.loads(result.stdout)
    except ValueError:continue
    if report.get('subject')==subject:
        if report.get('status')!='PASS':raise SystemExit('Synthetic delivery failed')
        print('Synthetic delivery confirmed')
        break
else:raise SystemExit('Synthetic sender deadline expired')
