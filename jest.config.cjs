process.env.NODE_ENV = 'test';
process.env.CDS_ENV = process.env.CDS_ENV || 'test';
process.env.SKIP_AUTO_INIT = process.env.SKIP_AUTO_INIT || 'true';
process.env.NO_TELEMETRY = 'true';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  setupFilesAfterEnv: [
    'ts-node/register/transpile-only',
    '<rootDir>/test/jest.setup.ts',
  ],

  testMatch: ['**/test/**/*.test.ts', '**/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],

  transform: {
    // Override `module` to CommonJS for tests so `await import(...)` in source
    // (e.g. chain-adapter's @odatano/core dynamic import) compiles to require()
    // — otherwise Node treats it as an ESM dynamic import that needs
    // --experimental-vm-modules.
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: {
        module: 'CommonJS',
        moduleResolution: 'node',
      },
    }],
  },

  transformIgnorePatterns: ['/node_modules/'],

  moduleNameMapper: {
    '^#cds-models/(.*)$': '<rootDir>/@cds-models/$1/index.js',
  },

  collectCoverageFrom: [
    'srv/**/*.ts',
    '!srv/**/*.d.ts',
    '!**/node_modules/**',
  ],

  // Single worker — cds.test boot can be heavy; matches ODATANO.
  maxWorkers: 1,

  // Generous timeout for cds.test bootstrap on cold CI runners.
  testTimeout: 60000,
  slowTestThreshold: 60000,

  // Tolerate the 5s polling setTimeout in trace-service if .unref() is not honored.
  openHandlesTimeout: 0,
  forceExit: true,
};
