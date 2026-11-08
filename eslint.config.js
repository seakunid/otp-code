export default [{
  files: ['dist/**/*.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  rules: { 'no-unreachable': 'error', 'no-constant-condition': 'error', 'no-dupe-args': 'error', 'no-dupe-keys': 'error', 'valid-typeof': 'error' }
}];
