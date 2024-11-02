// converter.js - Service B
require('dotenv').config();
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Initialize AWS S3 and SQS clients
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const S3_BUCKET = process.env.S3_BUCKET;

// Initialize WebSocket server on port 8080
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', (ws) => {
    ws.send('Welcome to the File Converter Service!');
});

// Function to process conversion jobs from SQS
async function processConversionJob() {
    const receiveCommand = new ReceiveMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
    });
    const response = await sqsClient.send(receiveCommand);

    if (!response.Messages) {
        return; // No messages, return and wait for the next interval
    }

    const message = response.Messages[0];
    const { username, fileName, format } = JSON.parse(message.Body);

    const inputFileKey = `${username}/${fileName}`;
    const outputFileName = `converted-${Date.now()}.${format}`;
    const outputFileKey = `${username}/${outputFileName}`;

    try {
        // Download file from S3
        const downloadCommand = new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: inputFileKey
        });
        const { Body } = await s3Client.send(downloadCommand);
        
        // Create a local file stream for downloading
        const inputFilePath = path.join(__dirname, fileName);
        const writeStream = fs.createWriteStream(inputFilePath);
        Body.pipe(writeStream);

        await new Promise((resolve) => writeStream.on('finish', resolve));

        // Convert file format using sharp
        const outputFilePath = path.join(__dirname, outputFileName);
        await sharp(inputFilePath).toFormat(format).toFile(outputFilePath);

        // Upload converted file back to S3
        const fileStream = fs.createReadStream(outputFilePath);
        await s3Client.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: outputFileKey,
            Body: fileStream
        }));

        // Clean up local files
        fs.unlinkSync(inputFilePath);
        fs.unlinkSync(outputFilePath);

        // Notify clients via WebSocket
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    message: 'File conversion completed',
                    file: outputFileName,
                    url: `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${outputFileKey}`
                }));
            }
        });

        // Delete the processed message from SQS
        const deleteCommand = new DeleteMessageCommand({
            QueueUrl: SQS_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle
        });
        await sqsClient.send(deleteCommand);
        console.log(`Processed and deleted message for file: ${fileName}`);

    } catch (error) {
        console.error("Error processing SQS message:", error);
    }
}

// Polling interval to fetch and process SQS messages
setInterval(processConversionJob, 5000);

console.log("Service B (File Converter) is running and listening for SQS messages...");
