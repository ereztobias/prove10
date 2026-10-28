import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The suite runs inside workerd against a real local D1, not a mock, so
// what passes here is what the deployed Worker does. The two secrets the
// code needs are bound to throwaway values. RESEND_API_KEY and MAIL_FROM
// are deliberately absent: sendMail returns false without them, which
// keeps the suite off the network and off a real mailbox.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          IP_SALT: 'salt-for-tests-only',
          ADMIN_PASSWORD: 'correct-horse-battery-staple',
        },
      },
    }),
  ],
  test: {
    // Kept small on purpose: this runs on a laptop that is often doing
    // something heavier at the same time.
    maxWorkers: 2,
    setupFiles: ['./test/setup.js'],
    include: ['test/*.test.js'],
  },
});
