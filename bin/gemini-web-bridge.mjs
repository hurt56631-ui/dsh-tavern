#!/usr/bin/env node
import { createGeminiWebHttpServer } from '../tavern-plugin/lib/domain/gemini-web-anonymous.js'

const host = '127.0.0.1'
const port = Number.parseInt(process.env.DSH_TAVERN_GEMINI_PORT || '8766', 10)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error('DSH_TAVERN_GEMINI_PORT must be between 1 and 65535')
  process.exit(1)
}
const server = createGeminiWebHttpServer()
server.listen(port, host, () => {
  console.log('Gemini Web anonymous bridge ready: http://' + host + ':' + port + '/v1')
  console.log('OpenAI-compatible provider: base URL http://' + host + ':' + port + '/v1 ; model gemini')
  console.log('No Gemini API key required; actual upstream access and model identity are not guaranteed.')
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
