import { defineConfig } from 'vitest/config';

// Cold start on Windows (antivirus + 9 files in parallel) can pass 5 s; 30 s avoids false failures.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
