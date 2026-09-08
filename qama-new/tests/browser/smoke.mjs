#!/usr/bin/env node
/**
 * Hosting smoke — verifies Arabic RTL page is served (no browser required).
 */
const HOST = process.env.FIREBASE_HOSTING_EMULATOR_HOST || "127.0.0.1:5000";
const url = `http://${HOST}/`;

const res = await fetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const html = await res.text();

if (!html.includes('dir="rtl"')) throw new Error("missing dir=rtl");
if (!html.includes('lang="ar"')) throw new Error("missing lang=ar");
if (!html.includes("قمة الرواسي")) throw new Error("missing Arabic title");
if (!html.includes("app.mjs")) throw new Error("missing app module");

console.log("HOSTING_SMOKE_PASS", url);
