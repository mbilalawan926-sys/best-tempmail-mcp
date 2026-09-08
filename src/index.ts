#!/usr/bin/env node
/**
 * MCP server for Best Temp Mail.
 *
 * Lets an AI assistant create disposable email inboxes, wait for mail, and
 * read verification codes out of it, so a person can say "sign me up for that
 * and get the code" and have it work end to end.
 *
 * Runs locally over stdio and talks to the Best Temp Mail API. An API key is
 * optional: without one the free tier applies, which is enough to try the
 * tools out. A paid key raises the rate limit and unlocks code extraction.
 *
 * Configure it in an MCP host like this:
 *
 *   {
 *     "mcpServers": {
 *       "best-tempmail": {
 *         "command": "npx",
 *         "args": ["-y", "best-tempmail-mcp"],
 *         "env": { "BTM_API_KEY": "btm_sk_live_..." }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  TempMail,
  PaymentRequiredError,
  RateLimitError,
  NotFoundError,
  TempMailError,
} from "best-tempmail";

const API_KEY = process.env.BTM_API_KEY;
const BASE_URL = process.env.BTM_BASE_URL;

const client = new TempMail({
  apiKey: API_KEY,
  ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
});

/** A tool result carrying human-readable text. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/**
 * Say how long to wait in units a person would use.
 *
 * The API reports seconds, which is right for code but unhelpful once the
 * number is large: "wait 65825 seconds" makes an assistant relay a figure
 * nobody can picture, when what it means is "tomorrow".
 */
function describeWait(seconds?: number): string {
  if (!seconds || seconds <= 0) return "Try again shortly.";
  if (seconds < 90) return `Try again in about ${Math.ceil(seconds)} seconds.`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `Try again in about ${minutes} minutes.`;
  const hours = Math.round(seconds / 3600);
  return `The limit resets in about ${hours} hour${hours === 1 ? "" : "s"}.`;
}

/**
 * Turn an error into something the model can act on.
 *
 * The distinction matters: a model that reads "requires a paid plan" can tell
 * the user to upgrade, whereas a bare stack trace leads it to retry pointlessly
 * or invent an explanation. Each case says plainly what happened and whether
 * trying again would help.
 */
function explain(err: unknown): string {
  if (err instanceof PaymentRequiredError) {
    return [
      `This needs a higher plan. The API key in use is on the ${err.plan ?? "free"} plan.`,
      "Retrying will not help.",
      err.upgradeUrl ? `Plans: ${err.upgradeUrl}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (err instanceof RateLimitError) {
    return `Rate limit reached. ${describeWait(err.retryAfter)} Or use an API key with a higher limit: https://best-tempmail.com/api/pricing`;
  }
  if (err instanceof NotFoundError) {
    return "Not found. The inbox or message may have expired: inboxes last 2 hours on the free and Developer plans, 24 hours on Pro.";
  }
  if (err instanceof TempMailError) {
    return `Request failed: ${err.message}`;
  }
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

/** Wrap a handler so a failure returns a useful message instead of crashing. */
async function guard(fn: () => Promise<ReturnType<typeof text>>) {
  try {
    return await fn();
  } catch (err) {
    return text(explain(err));
  }
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "best-tempmail",
    version: "1.0.0",
  });

  server.registerTool(
    "create_inbox",
    {
      title: "Create a disposable email inbox",
      description:
        "Create a temporary email address that can receive mail. Use this " +
        "when the user needs an email address for a signup, a trial, or " +
        "anything they do not want to give a real address to. Returns the " +
        "address and when it expires.",
      inputSchema: z.object({
        username: z
          .string()
          .optional()
          .describe(
            "Optional local part, for example 'my-test'. Lowercase letters, digits, dot, underscore and hyphen only. Random if omitted."
          ),
        domain: z
          .string()
          .optional()
          .describe("Optional domain from list_domains. Random if omitted."),
      }),
    },
    async ({ username, domain }) =>
      guard(async () => {
        const inbox = await client.createInbox({ username, domain });
        return text(
          [
            `Inbox created: ${inbox.address}`,
            `Expires: ${inbox.expiresAt}`,
            "",
            "Use wait_for_email to watch for mail arriving at this address.",
          ].join("\n")
        );
      })
  );

  server.registerTool(
    "wait_for_email",
    {
      title: "Wait for an email to arrive",
      description:
        "Wait for the next email to arrive at an inbox, up to 55 seconds. " +
        "Use this straight after triggering a signup or password reset. " +
        "Returns the message summary, or reports that nothing arrived. " +
        "Nothing arriving is not an error: the mail may simply be slow, and " +
        "calling this again continues waiting.",
      inputSchema: z.object({
        address: z.string().describe("The inbox address to watch."),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(55)
          .optional()
          .describe("Seconds to wait. Defaults to 30, maximum 55."),
      }),
    },
    async ({ address, timeout }) =>
      guard(async () => {
        const message = await client.waitForMessage(address, { timeout: timeout ?? 30 });
        if (!message) {
          return text(
            `No new mail arrived at ${address} within ${timeout ?? 30} seconds. ` +
              "Call wait_for_email again to keep waiting."
          );
        }
        return text(
          [
            `Mail arrived at ${address}`,
            `From: ${message.from}`,
            `Subject: ${message.subject}`,
            `Message id: ${message.id}`,
            message.hasAttachments ? "This message has attachments." : "",
            "",
            "Use get_verification_code to extract a code, or read_message for the full body.",
          ]
            .filter(Boolean)
            .join("\n")
        );
      })
  );

  server.registerTool(
    "get_verification_code",
    {
      title: "Extract the verification code from an email",
      description:
        "Pull the verification or one-time code out of a message. Use this " +
        "after wait_for_email when the user needs a code to complete a " +
        "signup or login. Requires a paid API key. If no code is found with " +
        "confidence, that is reported rather than guessed, because a wrong " +
        "code is worse than none.",
      inputSchema: z.object({
        address: z.string().describe("The inbox address."),
        message_id: z.string().describe("Message id from wait_for_email or list_messages."),
      }),
    },
    async ({ address, message_id }) =>
      guard(async () => {
        const otp = await client.getOtp(address, message_id);
        if (!otp.code) {
          const others = otp.candidates.length
            ? ` Possible candidates considered: ${otp.candidates.map((c) => c.code).join(", ")}.`
            : "";
          return text(
            `No verification code could be identified with confidence in this message.${others} ` +
              "Use read_message to look at the body directly."
          );
        }
        const caveat =
          otp.confidence === "low"
            ? " Confidence is low, so this is worth checking against the message body."
            : "";
        return text(`Verification code: ${otp.code} (confidence: ${otp.confidence}).${caveat}`);
      })
  );

  server.registerTool(
    "list_messages",
    {
      title: "List messages in an inbox",
      description:
        "List the messages currently in an inbox, newest first. Use this to " +
        "see what has already arrived, rather than waiting for something new.",
      inputSchema: z.object({
        address: z.string().describe("The inbox address."),
      }),
    },
    async ({ address }) =>
      guard(async () => {
        const messages = await client.getMessages(address);
        if (messages.length === 0) {
          return text(`No messages in ${address} yet. Use wait_for_email to wait for one.`);
        }
        const lines = messages.map(
          (m, i) =>
            `${i + 1}. ${m.subject}\n   From: ${m.from}\n   Id: ${m.id}${
              m.hasAttachments ? "\n   Has attachments" : ""
            }`
        );
        return text(`${messages.length} message(s) in ${address}:\n\n${lines.join("\n\n")}`);
      })
  );

  server.registerTool(
    "read_message",
    {
      title: "Read the full contents of a message",
      description:
        "Read a message's full body and attachment list. Use this when the " +
        "user wants to see what an email actually says, or when " +
        "get_verification_code could not find a code.",
      inputSchema: z.object({
        address: z.string().describe("The inbox address."),
        message_id: z.string().describe("Message id from wait_for_email or list_messages."),
      }),
    },
    async ({ address, message_id }) =>
      guard(async () => {
        const m = await client.getMessage(address, message_id);
        const parts = [
          `From: ${m.from}`,
          `Subject: ${m.subject}`,
          `Date: ${m.date}`,
          "",
          // Plain text where available. The HTML alternative is skipped
          // deliberately: it is mostly markup, and dumping it wastes the
          // model's context without adding meaning.
          m.text?.trim() || "(no plain text body; this message is HTML only)",
        ];
        if (m.attachments.length) {
          parts.push(
            "",
            "Attachments:",
            ...m.attachments.map(
              (a) =>
                `  ${a.index}. ${a.filename} (${a.mime}, ${a.size} bytes)` +
                (a.downloadable ? "" : ` [download requires the ${a.requiresPlan ?? "Pro"} plan]`)
            )
          );
        }
        return text(parts.join("\n"));
      })
  );

  server.registerTool(
    "list_domains",
    {
      title: "List available email domains",
      description:
        "List the domains inboxes can be created on. Only needed when the " +
        "user wants a specific domain; create_inbox picks one automatically.",
      inputSchema: z.object({}),
    },
    async () =>
      guard(async () => {
        const domains = await client.getDomains();
        return text(`Available domains:\n${domains.map((d) => `  ${d}`).join("\n")}`);
      })
  );

  server.registerTool(
    "delete_inbox",
    {
      title: "Delete an inbox",
      description:
        "Delete an inbox and everything in it. Inboxes expire on their own, " +
        "so this is only needed when the user wants it gone immediately.",
      inputSchema: z.object({
        address: z.string().describe("The inbox address to delete."),
      }),
    },
    async ({ address }) =>
      guard(async () => {
        const ok = await client.deleteInbox(address);
        return text(ok ? `Deleted ${address}.` : `Could not delete ${address}.`);
      })
  );

  return server;
}

serveStdio(() => buildServer());
