import { main } from "./main.js";

process.exitCode = await main(process.argv[2], {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
});
