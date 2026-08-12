import { Prisma } from "@prisma/client";

export function isPrismaUniqueConstraintError(
  error: unknown,
  input: {
    fields: readonly string[];
    constraintNames?: readonly string[];
  },
): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError)
    || error.code !== "P2002"
  ) {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.length === input.fields.length
      && target.every((field, index) => field === input.fields[index]);
  }
  if (typeof target !== "string") return false;
  return target === input.fields.join("_")
    || (input.fields.length === 1 && target === input.fields[0])
    || (input.constraintNames ?? []).includes(target);
}
