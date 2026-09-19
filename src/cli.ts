#!/usr/bin/env node
import { createCli } from './create-cli.js'

// Export nothing: Bun serves an entry's default export that has `fetch` over
// HTTP, which would expose every Slack method with the stored credentials.
await createCli().serve()
