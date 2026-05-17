process.env.NO_TELEMETRY = 'true';
process.env.SKIP_AUTO_INIT = process.env.SKIP_AUTO_INIT || 'true';

import cds from '@sap/cds';
cds.User.default = cds.User.Privileged as unknown as cds.User;

/* eslint-disable no-console */
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
const originalConsoleDebug = console.debug;
const originalConsoleError = console.error;
const originalConsoleDir = console.dir;

const suppressLogs =
  process.env.LOG_LEVEL !== 'debug' &&
  (process.env.LOG_LEVEL === 'error' || process.env.NODE_ENV === 'test');

if (suppressLogs) {
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.debug = () => {};
  console.error = () => {};
  console.dir = () => {};
}

afterAll(() => {
  console.log = originalConsoleLog;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
  console.debug = originalConsoleDebug;
  console.error = originalConsoleError;
  console.dir = originalConsoleDir;
});
