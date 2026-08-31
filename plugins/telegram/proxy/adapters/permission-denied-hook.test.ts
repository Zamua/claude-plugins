import { describe, expect, test } from 'bun:test'
import { join } from 'path'

const hook = join(import.meta.dir, '..', '..', 'hooks', 'permission-denied.py')

describe('PermissionDenied hook adapter', () => {
  test('injects the approval protocol when a session starts or resumes', async () => {
    const child = Bun.spawn(['python3', hook], {
      env: { ...Bun.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    child.stdin.write(JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' }))
    child.stdin.end()

    expect(await child.exited).toBe(0)
    const output = JSON.parse(await new Response(child.stdout).text())
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(output.hookSpecificOutput.additionalContext).toContain('retry only that action')
    expect(output.hookSpecificOutput.additionalContext).toContain('do not retry it twice')
    expect(output.hookSpecificOutput.additionalContext).toContain('Never broaden')
  })

  test('forwards the denial with its topic and exits without requesting an immediate retry', async () => {
    const harness = `
import importlib.util, io, json, os, sys
spec = importlib.util.spec_from_file_location("permission_denied", os.environ["HOOK_PATH"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
captured = {}
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self): return b""
def fake_urlopen(request, timeout):
    captured.update(url=request.full_url, body=json.loads(request.data), timeout=timeout)
    return Response()
module.urlopen = fake_urlopen
sys.stdin = io.StringIO(os.environ["HOOK_EVENT"])
exit_code = module.main()
print(json.dumps({"exit": exit_code, **captured}))
`
    const event = {
      hook_event_name: 'PermissionDenied',
      session_id: 'session-1',
      tool_name: 'Bash',
      tool_input: { command: 'git push', description: 'Push the reviewed branch' },
      tool_use_id: 'tool-1',
      reason: 'Blocked by classifier',
    }
    const child = Bun.spawn(['python3', '-c', harness], {
      env: {
        ...Bun.env,
        HOOK_PATH: hook,
        HOOK_EVENT: JSON.stringify(event),
        TELEGRAM_TOPIC_ID: '1133',
        TELEGRAM_PROXY_URL: 'http://127.0.0.1:8790',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const exit = await child.exited
    expect(exit).toBe(0)
    const captured = JSON.parse(await new Response(child.stdout).text())
    expect(captured.exit).toBe(0)
    expect(captured.url).toBe('http://127.0.0.1:8790/permission-denied')
    const body = captured.body
    expect(body.topic).toBe('1133')
    expect(body.session_id).toBe('session-1')
    expect(body.tool_input).toEqual(event.tool_input)
  })

  test('fails open when the local proxy is unavailable', async () => {
    const child = Bun.spawn(['python3', hook], {
      env: {
        ...Bun.env,
        TELEGRAM_TOPIC_ID: '1133',
        TELEGRAM_PROXY_URL: 'http://127.0.0.1:1',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    child.stdin.write(JSON.stringify({
      hook_event_name: 'PermissionDenied',
      session_id: 'session-1',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
      tool_use_id: 'tool-1',
      reason: 'Blocked by classifier',
    }))
    child.stdin.end()

    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe('')
  })
})
