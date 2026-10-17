// Jest setupFiles entry: keep Bunyan quiet during test runs unless a caller
// explicitly asks for a level. Bunyan writes straight to stdout, bypassing
// Jest's console capture, so without this every logged line lands in the run.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "fatal";
