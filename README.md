# best-tempmail-mcp

<!-- The line below is required by the Official MCP Registry. It proves this
     npm package and the registry entry belong to the same owner. Do not
     remove it. -->
mcp-name: io.github.mbilalawan926-sys/best-tempmail-mcp

MCP server for [Best Temp Mail](https://best-tempmail.com/api). Gives an AI assistant its own disposable email inboxes, so it can sign up for things, wait for the mail, and read the verification code back to you.

> "Create a temp email, sign me up for that newsletter, and tell me the confirmation code."

## Install

Add this to your MCP host's configuration. No installation step: `npx` fetches it on first run.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "best-tempmail": {
      "command": "npx",
      "args": ["-y", "best-tempmail-mcp"]
    }
  }
}
```

**With an API key**, for higher limits and verification code extraction:

```json
{
  "mcpServers": {
    "best-tempmail": {
      "command": "npx",
      "args": ["-y", "best-tempmail-mcp"],
      "env": { "BTM_API_KEY": "btm_sk_live_..." }
    }
  }
}
```

The same shape works in Cursor, VS Code, Claude Code, and other MCP hosts.

Restart the host after editing the config.

## Tools

| Tool | What it does |
| --- | --- |
| `create_inbox` | Create a disposable address |
| `wait_for_email` | Wait up to 55s for mail to arrive |
| `get_verification_code` | Pull the OTP out of a message (paid key) |
| `list_messages` | See what has already arrived |
| `read_message` | Read the full body and attachment list |
| `list_domains` | Available domains |
| `delete_inbox` | Delete an inbox and its contents |

## Without an API key

Everything works except `get_verification_code`, on the free tier: 150 requests per hour and 3 inboxes per day. That is enough to try it properly.

A paid key raises the limit to 2,000 requests per hour, unlocks code extraction, and allows commercial use. See [pricing](https://best-tempmail.com/api/pricing).

## What it looks like in use

> **You:** Make me a temp email and sign up for the newsletter at example.com
>
> The assistant calls `create_inbox`, gets `abc1234@dextde.site`, fills in the form, then calls `wait_for_email`.
>
> **Assistant:** Signed up with abc1234@dextde.site. The confirmation email arrived; your code is 889231.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BTM_API_KEY` | Optional. Paid plan key. |
| `BTM_BASE_URL` | Optional. Override the API base, for testing. |

## Notes

Inboxes expire on their own: 2 hours on the free and Developer plans, 24 hours on Pro. They are receive-only, so nothing can be sent from them.

If a verification code cannot be identified with confidence, the tool says so rather than guessing. A wrong code is worse than none, and the assistant can fall back to `read_message` to look at the body itself.

## Links

- [API documentation](https://best-tempmail.com/api)
- [Node SDK](https://www.npmjs.com/package/best-tempmail)
- [Python SDK](https://pypi.org/project/best-tempmail/)

## License

MIT
