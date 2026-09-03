import { z } from "zod";

export function parsedHttpsUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? parsed : null;
  } catch {
    return null;
  }
}

export const publicHttpsUrlSchema = z.string().max(2_048)
  .refine((value) => parsedHttpsUrl(value) !== null, { message: "public_url.invalid" });
