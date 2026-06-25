#!/usr/bin/env node

/**
 * Utility script to upload local event data files to S3
 * Usage: node upload-to-s3.js <file-path>
 * Example: node upload-to-s3.js data/events_2026-01-23_21-36-31.json
 */

import { uploadFileToS3, isS3Configured, getS3Bucket } from './s3-storage.js';
import { loadEnv } from './env-loader.js';
import fs from 'fs/promises';
import path from 'path';

// Load environment variables
loadEnv();

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logError(message, error) {
  console.error(`[${new Date().toISOString()}] ❌ ${message}`, error?.message || error);
}

async function uploadFile(filePath) {
  try {
    // Check if S3 is configured
    if (!isS3Configured()) {
      logError('S3 is not configured', 
        'Please set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_S3_BUCKET environment variables');
      process.exit(1);
    }

    const bucket = getS3Bucket();
    
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      logError('File not found', `Could not access file: ${filePath}`);
      process.exit(1);
    }

    // Generate S3 key from file path
    // e.g., data/events_2026-01-23_21-36-31.json -> events/events_2026-01-23_21-36-31.json
    const fileName = path.basename(filePath);
    const s3Key = `events/${fileName}`;

    log(`📤 Uploading ${filePath} to S3...`);
    log(`   Bucket: ${bucket}`);
    log(`   Key: ${s3Key}`);

    const s3Url = await uploadFileToS3(filePath, s3Key, bucket);
    
    log(`✅ Successfully uploaded to S3!`);
    log(`   URL: ${s3Url}`);
    
    return s3Url;
  } catch (error) {
    logError('Upload failed', error);
    process.exit(1);
  }
}

async function uploadAllFilesInDirectory(dirPath) {
  try {
    log(`📂 Scanning directory: ${dirPath}`);
    
    const files = await fs.readdir(dirPath);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    if (jsonFiles.length === 0) {
      log('⚠️  No JSON files found in directory');
      return;
    }

    log(`📦 Found ${jsonFiles.length} JSON files`);
    
    for (const file of jsonFiles) {
      const filePath = path.join(dirPath, file);
      await uploadFile(filePath);
      log(''); // Empty line for readability
    }
    
    log(`✅ Uploaded all ${jsonFiles.length} files successfully!`);
  } catch (error) {
    logError('Batch upload failed', error);
    process.exit(1);
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
📤 S3 Upload Utility for NYC Events Data

Usage:
  node upload-to-s3.js <file-or-directory>

Examples:
  # Upload a single file
  node upload-to-s3.js data/events_2026-01-23_21-36-31.json
  
  # Upload all files in data directory
  node upload-to-s3.js data/

Environment Variables Required:
  AWS_ACCESS_KEY_ID       - Your AWS access key
  AWS_SECRET_ACCESS_KEY   - Your AWS secret key
  AWS_S3_BUCKET           - Your S3 bucket name
  AWS_REGION              - AWS region (optional, defaults to us-east-1)

Current Configuration:
  S3 Configured: ${isS3Configured() ? '✅ Yes' : '❌ No'}
  Bucket: ${getS3Bucket() || '(not set)'}
  Region: ${process.env.AWS_REGION || 'us-east-1 (default)'}
    `);
    process.exit(0);
  }

  const target = args[0];
  
  try {
    const stats = await fs.stat(target);
    
    if (stats.isDirectory()) {
      await uploadAllFilesInDirectory(target);
    } else if (stats.isFile()) {
      await uploadFile(target);
    } else {
      logError('Invalid target', 'Target is neither a file nor a directory');
      process.exit(1);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      logError('Not found', `File or directory not found: ${target}`);
    } else {
      logError('Error', error);
    }
    process.exit(1);
  }
}

main();
