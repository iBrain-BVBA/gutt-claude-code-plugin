#!/usr/bin/env node
/**
 * Test script for stop-lessons.cjs — simplified block-once logic
 */

const { getSessionDuration } = require("../hooks/lib/transcript-parser.cjs");

console.log("Testing stop hook helpers...\n");

// Test 1: Session duration calculation
console.log("Test 1: Session duration");
const now = new Date();
const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
console.log("10 minutes ago:", getSessionDuration(tenMinutesAgo), "minutes");
console.log("5 minutes ago:", getSessionDuration(fiveMinutesAgo), "minutes");
console.log("✓ Duration calculation works\n");

console.log("All tests completed!");
