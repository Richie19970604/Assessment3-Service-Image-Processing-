// service-image-processing/app.js

require('dotenv').config();
const express = require('express');
const sharp = require('sharp');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const stream = require('stream');
const { promisify } = require('util');

const app = express();
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const S3_BUCKET = process.env.S3_BUCKET;
const QUEUE_URL = process.env.SQS_QUEUE_URL;

const pipeline = promisify(stream.pipeline);

async function processImages() {
    const command = new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
    });

    try {
        const response = await sqsClient.send(command);
        if (response.Messages) {
            for (const message of response.Messages) {
                const { username, format, s3Key } = JSON.parse(message.Body);

                console.log("Processing image with s3Key:", s3Key);

        
                const getObjectCommand = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key });
                const s3Response = await s3Client.send(getObjectCommand);


                const transformStream = sharp().toFormat(format);
                const outputBuffer = await pipeline(s3Response.Body, transformStream);


                const outputKey = `${username}/converted-${Date.now()}.${format}`;
                await s3Client.send(new PutObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: outputKey,
                    Body: outputBuffer,
                    ContentType: `image/${format}`
                }));

                console.log(`Processed image uploaded to S3 as ${outputKey}`);

                const deleteCommand = new DeleteMessageCommand({
                    QueueUrl: QUEUE_URL,
                    ReceiptHandle: message.ReceiptHandle,
                });
                await sqsClient.send(deleteCommand);
            }
        }
    } catch (error) {
        console.error('Error processing image:', error);
    }
}

setInterval(processImages, 5000);

app.listen(3000, () => {
    console.log('Image Processing Service is running on port 3000');
});
