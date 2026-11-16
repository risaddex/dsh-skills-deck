#!/usr/bin/env node
// scripts/linear-app-signin.mts — sign an oauth_app Linear account in by hand (ticket #19, runbook step 3+4).
// Reads the client id and secret from the terminal (the secret is not echoed), asks Linear for an app token with
// the fixed scope read,write, and writes the grant record skills-deck/linear-<alias> into the credentials file.
// Prints only whether it worked. The token and the secret are never printed and never written anywhere else.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const alias = process.argv[2] || 'ombrello'
const file = process.env.DSH_CREDENTIALS_FILE || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml')
const tokenUrl = process.env.LINEAR_TOKEN_URL || 'https://api.linear.app/oauth/token'
if (!/^[a-z][a-z0-9-]{1,15}$/.test(alias)) { console.error('alias must be 2-16 lowercase letters, digits or hyphens'); process.exit(2) }

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) { (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s) } }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()) })
  })
}
// LINEAR_SIGNIN_TEST_INPUT exists only so the file-writing half can be tested without a terminal; a person never sets it.
const injected = process.env.LINEAR_SIGNIN_TEST_INPUT ? process.env.LINEAR_SIGNIN_TEST_INPUT.split('\n') : null
const clientId = injected ? injected[0].trim() : await ask('client id: ', false)
const clientSecret = injected ? (injected[1] || '').trim() : await ask('client secret: ', true)
if (!clientId || !clientSecret) { console.error('both are required'); process.exit(2) }

const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'read,write', client_id: clientId, client_secret: clientSecret })
let res: Response
let json: { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }
try {
  res = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body })
  json = await res.json().catch(() => ({}))
} catch (e) { console.error('FAILED: could not reach Linear (' + String((e as Error) && (e as Error).message || e).slice(0, 100) + ')'); process.exit(1) }
if (!res.ok || !json.access_token) {
  console.error('FAILED: HTTP ' + res.status + ' ' + JSON.stringify({ error: json.error, description: json.error_description }))
  process.exit(1)
}

const now = Date.now()
const payload = { mode: 'oauth_app', alias, clientId, clientSecret, accessToken: json.access_token, expiresAt: json.expires_in ? now + json.expires_in * 1000 : 0, scope: String(json.scope || 'read,write').split(/[\s,]+/).filter(Boolean), obtainedAt: now }
const key = 'skills-deck/linear-' + alias
// The credential file is YAML; JSON is valid YAML, so the record is written as one flow-style line and the rest is kept as is.
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'version: 1\nrecords:\nrefs:\n'
if (!/^records:/m.test(text)) text = text.replace(/\s*$/, '\n') + 'records:\n'
const entry = '  ' + key + ': ' + JSON.stringify({ kind: 'grant', payload }) + '\n'
const existing = new RegExp('^  ' + key.replace(/[/-]/g, '\\$&') + ':.*\\n', 'm')
text = existing.test(text) ? text.replace(existing, entry) : text.replace(/^records:\s*\n/m, 'records:\n' + entry)
const tmp = file + '.tmp-' + process.pid
fs.writeFileSync(tmp, text, { mode: 0o600 })
fs.renameSync(tmp, file)
fs.chmodSync(file, 0o600)
console.log('ok: stored ' + key + ' (expires in ' + (json.expires_in || '?') + 's, scope ' + payload.scope.join(',') + '). Nothing else was written.')
