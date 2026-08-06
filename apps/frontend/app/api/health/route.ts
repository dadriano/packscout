import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "packscout-frontend",
    framework: "next",
  });
}
