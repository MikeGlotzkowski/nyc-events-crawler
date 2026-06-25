import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs/promises';

// ============================================================================
// S3 STORAGE MODULE
// ============================================================================

let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    const region = process.env.AWS_REGION || 'us-east-1';
    
    // The SDK automatically reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
    // from environment variables
    s3Client = new S3Client({ 
      region,
      // Optional: Add credentials explicitly if needed
      // credentials: {
      //   accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      //   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      // }
    });
  }
  return s3Client;
}

/**
 * Upload a file to S3
 * @param {string} filePath - Local file path to upload
 * @param {string} s3Key - S3 object key (path within bucket)
 * @param {string} bucket - S3 bucket name
 * @returns {Promise<string>} - S3 URL of uploaded file
 */
export async function uploadFileToS3(filePath, s3Key, bucket) {
  try {
    const fileContent = await fs.readFile(filePath);
    const client = getS3Client();
    
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: fileContent,
      ContentType: 'application/json',
    });

    await client.send(command);
    
    const s3Url = `https://${bucket}.s3.amazonaws.com/${s3Key}`;
    return s3Url;
  } catch (error) {
    throw new Error(`Failed to upload to S3: ${error.message}`);
  }
}

/**
 * Upload JSON data directly to S3 (without saving locally first)
 * @param {Object|Array} data - JSON data to upload
 * @param {string} s3Key - S3 object key (path within bucket)
 * @param {string} bucket - S3 bucket name
 * @returns {Promise<string>} - S3 URL of uploaded file
 */
export async function uploadDataToS3(data, s3Key, bucket) {
  try {
    const client = getS3Client();
    const jsonContent = JSON.stringify(data, null, 2);
    
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: jsonContent,
      ContentType: 'application/json',
    });

    await client.send(command);
    
    const s3Url = `https://${bucket}.s3.amazonaws.com/${s3Key}`;
    return s3Url;
  } catch (error) {
    throw new Error(`Failed to upload data to S3: ${error.message}`);
  }
}

/**
 * Check if S3 storage is configured
 * @returns {boolean}
 */
export function isS3Configured() {
  return !!(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_BUCKET
  );
}

/**
 * Get S3 bucket name from environment
 * @returns {string}
 */
export function getS3Bucket() {
  return process.env.AWS_S3_BUCKET || '';
}
