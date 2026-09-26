import { parseArgs } from "node:util";
import { startShop } from "./server.js";
import { isVariant, VARIANT_DESCRIPTIONS, VARIANTS } from "./variants.js";

// pnpm --filter <this package> start -- --variant cosmetic --port 4100

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    variant: { type: "string", default: "correct" },
    port: { type: "string", default: "4100" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write("Usage: start [--variant <name>] [--port <number>]\n\nVariants:\n");
  for (const name of VARIANTS)
    process.stdout.write(`  ${name.padEnd(22)} ${VARIANT_DESCRIPTIONS[name]}\n`);
  process.exit(0);
}

if (!isVariant(values.variant)) {
  process.stderr.write(`Unknown variant "${values.variant}". Use one of: ${VARIANTS.join(", ")}\n`);
  process.exit(1);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`Invalid port "${values.port}"\n`);
  process.exit(1);
}

const shop = await startShop({ variant: values.variant, port });
process.stdout.write(`Acme Shop (${shop.variant}) listening on ${shop.url}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shop.stop().then(() => process.exit(0));
  });
}
