#!/usr/bin/env node
import { verifyPackage } from '../packaging/verify.mjs';
if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-package.mjs <Klaus.app or Windows package directory>');
console.log(JSON.stringify(verifyPackage(process.argv[2]), null, 2));
