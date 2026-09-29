const globals = require('globals');

/**
 * Two environments in one repo and no build step, so the config has to say
 * which is which: `src/` and `testmedia/` are CommonJS running in Node, and
 * `public/` is plain scripts running in a browser with no bundler and no
 * module system.
 *
 * The rules are deliberately few. This is here to catch the mistakes that are
 * invisible in review - a typo'd variable, an unused import left behind by a
 * refactor, a promise nobody awaited - not to enforce a style. Formatting
 * arguments are not worth the churn on a project this size.
 */
module.exports = [
  {
    ignores: ['node_modules/**', 'storage/**', 'testmedia/*.jpg', 'testmedia/*.mp4', 'testmedia/*.png'],
  },

  // Server, scripts and tests: Node, CommonJS.
  {
    files: ['src/**/*.js', 'testmedia/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', {
        // Express identifies an error handler by its arity, so errorHandler
        // must declare `next` even though it never calls it.
        args: 'after-used',
        argsIgnorePattern: '^_|^next$',
        caughtErrors: 'none',
      }],
      'no-undef': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-return-await': 'error',
      // A floating promise in a route handler is how a request hangs forever.
      'no-async-promise-executor': 'error',
    },
  },

  // Client: browser globals, classic scripts sharing one global scope, which
  // is why no-redeclare across files is not something this can check.
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
