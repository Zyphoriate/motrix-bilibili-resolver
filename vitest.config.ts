import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^motrix:plugin-api$/,
        replacement: fileURLToPath(
          new URL('./tests/mocks/motrix-plugin-api.ts', import.meta.url)
        ),
      },
    ],
  },
})
