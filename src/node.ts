import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { serve } from '@hono/node-server'
import app from './index.js'

// Render / Node.js adapter. Workers uses src/index.ts directly.
app.get('/', async (c) => {
  return c.html(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'))
})

app.get('/style.css', async (c) => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8')
  return c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8' })
})

serve({
  fetch: (request) => app.fetch(request, { DATABASE_URL: process.env.DATABASE_URL }),
  port: Number(process.env.PORT ?? 3000)
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
