#!/usr/bin/env bun
/**
 * build.ts — GAZE build pipeline
 * 
 * Reads data.json + index.template.html → writes index.html
 * Inlines the data arrays into the placeholder slots.
 * 
 * Usage: bun scripts/build.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Load data
const data = JSON.parse(readFileSync(join(root, 'data.json'), 'utf-8'));

// Load template
let template = readFileSync(join(root, 'index.template.html'), 'utf-8');

// Inline each array into its placeholder
const replacements: Record<string, string> = {
  '@BUILD:repos': JSON.stringify(data.repos),
  '@BUILD:fragments': JSON.stringify(data.fragments),
  '@BUILD:commitDays': JSON.stringify(data.commitDays),
  '@BUILD:sessionDays': JSON.stringify(data.sessionDays),
};

for (const [marker, json] of Object.entries(replacements)) {
  const pattern = new RegExp(`/\\* ${marker} \\*/ \\[\\]`);
  if (!pattern.test(template)) {
    throw new Error(`Build marker not found: ${marker}`);
  }
  template = template.replace(pattern, json);
}

// Write output
writeFileSync(join(root, 'index.html'), template);
console.log(`✓ Built index.html (${template.length} bytes) from data.json`);
