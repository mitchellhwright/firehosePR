import baseConfig from '../../server/vitest.config.ts';

// Keep the shared test runtime while replacing its include list, so every
// integration suite is discovered recursively and ordinary tests stay out.
const integrationConfig = {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['server/tests/**/*.integration.test.ts'],
  },
} satisfies typeof baseConfig;

export default integrationConfig;
