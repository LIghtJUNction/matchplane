import { readFile } from "node:fs/promises";

export async function loadInternalBearer(inlineVariable: string, fileVariable: string): Promise<string> {
  const inline = process.env[inlineVariable]?.trim();
  if (inline) return inline;
  const path = process.env[fileVariable]?.trim();
  if (path) {
    const token = (await readFile(path, "utf8")).trim();
    if (token) return token;
  }
  throw new Error(`${inlineVariable} or ${fileVariable} is required`);
}
