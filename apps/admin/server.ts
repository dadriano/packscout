import express from "express";
import app from "./dist/server.bundle.mjs";

// Keep Express directly visible at Vercel's conventional discovery boundary.
void express;

export default app;
