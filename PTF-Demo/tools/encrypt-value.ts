#!/usr/bin/env ts-node

import { CSEncryptionUtil } from '../src/utils/CSEncryptionUtil';

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log(`
Usage: npx ts-node tools/encrypt-value.ts <value-to-encrypt>

This tool encrypts a value using the CS Framework encryption standard.
The encrypted value can be used in .env files with the ENCRYPTED: prefix.

Example:
    npx ts-node tools/encrypt-value.ts "myPassword123"
    
Output can be used in .env file as:
    PASSWORD=ENCRYPTED:eyJlbmNyeXB0ZWQiOi...
`);
    process.exit(0);
}

const valueToEncrypt = args.join(' ');
const encryptionUtil = CSEncryptionUtil.getInstance();
const encrypted = encryptionUtil.encrypt(valueToEncrypt);

console.log('\n=== CS Framework Encryption Tool ===');
console.log('Original Value:', valueToEncrypt);
console.log('Encrypted Value:', encrypted);
console.log('\nUse this in your .env file as:');
console.log(`YOUR_KEY=${encrypted}`);