import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const MAX_SNAPSHOT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const args = { config: "reservation.example.json" };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config" && argv[index + 1]) {
      args.config = argv[index + 1];
      index += 1;
    } else if (value === "--headless") {
      args.headless = true;
    }
  }

  return args;
}

async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(raw);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }

  return value;
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...truncated...`;
}

async function snapshotPage(page) {
  const url = page.url();
  const title = await page.title();
  const html = await page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const interactive = Array.from(
      document.querySelectorAll("a, button, input, select, textarea, [role='button']")
    )
      .slice(0, 120)
      .map((element, index) => {
        const tag = element.tagName.toLowerCase();
        const text = (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim();
        const id = element.id ? `#${element.id}` : "";
        const name = element.getAttribute("name") ? `[name="${element.getAttribute("name")}"]` : "";
        const type = element.getAttribute("type") ? ` type=${element.getAttribute("type")}` : "";
        return `${index + 1}. ${tag}${id}${name}${type} :: ${text}`.trim();
      })
      .join("\n");

    return {
      bodyText,
      interactive
    };
  });

  return truncate(
    [
      `URL: ${url}`,
      `Title: ${title}`,
      "",
      "Visible text:",
      html.bodyText,
      "",
      "Interactive elements:",
      html.interactive
    ].join("\n"),
    MAX_SNAPSHOT_CHARS
  );
}

function buildTools() {
  return [
    {
      name: "goto_url",
      description: "Open a new URL in the current browser tab.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Destination URL." }
        },
        required: ["url"]
      }
    },
    {
      name: "click_element",
      description: "Click an element identified by a Playwright selector.",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "A Playwright selector such as text=Login or #submit." }
        },
        required: ["selector"]
      }
    },
    {
      name: "type_text",
      description: "Type into a field identified by a Playwright selector. If text starts with env:, the environment variable value is used.",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "A Playwright selector." },
          text: { type: "string", description: "Text to type. Supports env:ENV_NAME." }
        },
        required: ["selector", "text"]
      }
    },
    {
      name: "wait_for_text",
      description: "Wait until specific text appears somewhere on the page.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Visible text to wait for." },
          timeoutMs: { type: "number", description: "Optional timeout in milliseconds." }
        },
        required: ["text"]
      }
    },
    {
      name: "read_page",
      description: "Read the current page state before deciding the next action.",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "finish_task",
      description: "Declare that the reservation flow is complete.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Short summary of what was completed." }
        },
        required: ["summary"]
      }
    }
  ];
}

async function executeTool(page, toolName, input) {
  switch (toolName) {
    case "goto_url":
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
      return `Opened ${input.url}`;
    case "click_element":
      await page.click(input.selector, { timeout: DEFAULT_TIMEOUT_MS });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return `Clicked ${input.selector}`;
    case "type_text": {
      const text = input.text.startsWith("env:") ? requireEnv(input.text.slice(4)) : input.text;
      await page.fill(input.selector, text, { timeout: DEFAULT_TIMEOUT_MS });
      return `Filled ${input.selector}`;
    }
    case "wait_for_text":
      await page.getByText(input.text, { exact: false }).waitFor({
        timeout: input.timeoutMs || DEFAULT_TIMEOUT_MS
      });
      return `Found text: ${input.text}`;
    case "read_page":
      return await snapshotPage(page);
    case "finish_task":
      return `Task marked complete: ${input.summary}`;
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function buildSystemPrompt(config) {
  return [
    "You are an automation agent operating a browser to reserve a lesson.",
    "Always inspect the page with read_page before risky actions when the UI may have changed.",
    "Use Playwright selectors that are short and robust.",
    "Credentials are available only through env:LESSON_USER_ID and env:LESSON_PASSWORD.",
    "Do not change account settings or cancel existing reservations.",
    "If a confirmation screen appears, verify the lesson date and time match the user request before final confirmation.",
    "When the reservation is complete, call finish_task."
  ].join(" ");
}

function buildUserPrompt(config) {
  const successIndicators = (config.successIndicators || []).join(", ");

  return [
    `Start URL: ${config.startUrl}`,
    `Task: ${config.task}`,
    "Login ID: env:LESSON_USER_ID",
    "Password: env:LESSON_PASSWORD",
    successIndicators ? `Success indicators: ${successIndicators}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function run() {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.config);
  requireEnv("ANTHROPIC_API_KEY");

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const browser = await chromium.launch({ headless: args.headless ?? config.headless ?? false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });

  const tools = buildTools();
  const messages = [
    {
      role: "user",
      content: buildUserPrompt(config)
    }
  ];

  await page.goto(config.startUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });

  for (let step = 1; step <= (config.maxSteps || 20); step += 1) {
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1200,
      system: buildSystemPrompt(config),
      tools,
      messages
    });

    messages.push({
      role: "assistant",
      content: response.content
    });

    const toolUses = response.content.filter((item) => item.type === "tool_use");
    if (toolUses.length === 0) {
      const text = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      console.log(text || "Claude finished without tool calls.");
      break;
    }

    const toolResults = [];
    let finished = false;

    for (const toolUse of toolUses) {
      const result = await executeTool(page, toolUse.name, toolUse.input);
      console.log(`[step ${step}] ${toolUse.name}: ${result}`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result
      });

      if (toolUse.name === "finish_task") {
        finished = true;
      }
    }

    messages.push({
      role: "user",
      content: toolResults
    });

    if (finished) {
      break;
    }
  }

  const finalSnapshot = await snapshotPage(page);
  console.log("\nFinal page snapshot:\n");
  console.log(finalSnapshot);

  await browser.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
