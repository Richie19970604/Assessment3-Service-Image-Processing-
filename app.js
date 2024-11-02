require('dotenv').config();
const express = require('express');  // 添加 Express
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 初始化 Express 应用
const app = express();

// AWS 配置
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const S3_BUCKET = process.env.S3_BUCKET;
const SERVICE_A_URL = process.env.SERVICE_A_URL;  // `Service A` 的 URL

// 通知 `Service A` 转换状态
async function notifyServiceA(username, fileName, status, url = '') {
    try {
        await axios.post(`${SERVICE_A_URL}/api/update-status`, {
            username,
            fileName,
            status,
            url,
            message: status === 'completed' ? 'File conversion successful' : 'File conversion failed',
        });
        console.log(`Status for ${fileName} updated to ${status} in Service A.`);
    } catch (error) {
        console.error('Failed to notify Service A:', error);
    }
}

// 处理文件转换任务
async function processConversionJob() {
    const receiveCommand = new ReceiveMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
    });
    const response = await sqsClient.send(receiveCommand);

    if (!response.Messages) {
        return; // 没有消息，返回等待下次轮询
    }

    const message = response.Messages[0];
    const { username, fileName, format } = JSON.parse(message.Body);

    const inputFileKey = `${username}/${fileName}`;
    const outputFileName = `converted-${Date.now()}.${format}`;
    const outputFileKey = `${username}/${outputFileName}`;

    try {
        // 从 S3 下载文件
        const downloadCommand = new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: inputFileKey
        });
        const { Body } = await s3Client.send(downloadCommand);
        
        const inputFilePath = path.join(__dirname, fileName);
        const writeStream = fs.createWriteStream(inputFilePath);
        Body.pipe(writeStream);

        await new Promise((resolve) => writeStream.on('finish', resolve));

        // 使用 sharp 转换文件格式
        const outputFilePath = path.join(__dirname, outputFileName);
        await sharp(inputFilePath).toFormat(format).toFile(outputFilePath);

        // 将转换后的文件上传回 S3
        const fileStream = fs.createReadStream(outputFilePath);
        await s3Client.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: outputFileKey,
            Body: fileStream
        }));

        // 清理本地临时文件
        fs.unlinkSync(inputFilePath);
        fs.unlinkSync(outputFilePath);

        // 通知 `Service A` 完成状态
        const fileUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${outputFileKey}`;
        await notifyServiceA(username, outputFileName, 'completed', fileUrl);

        // 从 SQS 删除已处理的消息
        const deleteCommand = new DeleteMessageCommand({
            QueueUrl: SQS_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle
        });
        await sqsClient.send(deleteCommand);
        console.log(`Processed and deleted message for file: ${fileName}`);

    } catch (error) {
        console.error("Error processing SQS message:", error);
        // 通知 `Service A` 转换失败
        await notifyServiceA(username, fileName, 'failed');
    }
}

// 设置轮询间隔以处理 SQS 消息
setInterval(processConversionJob, 5000);

console.log("Service B (File Converter) is running and listening for SQS messages...");

// 启动 Express 服务器监听 8080 端口（仅用于调试或状态检查）
app.get('/', (req, res) => res.send("Service B is running."));
app.listen(8080, () => {
    console.log('Service B HTTP server running on port 8080');
});
