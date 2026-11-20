import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: [
      'dist/**/*',
      'dist-electron/**/*',
      'release/**/*',
      'node_modules/**/*',
      'src/**/*',
      'electron/**/*',
      'scripts/**/*',
      'server.ts',
      'vite.config.ts',
      'firestore.rules.test.ts',
    ],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
