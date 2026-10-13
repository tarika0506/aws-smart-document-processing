# Smart Document Processing & Duplicate Detector

## AWS services simulated
- Amazon S3: document/object storage
- Amazon EventBridge: event routing after an S3 ObjectCreated event
- AWS Lambda: serverless document-processing function
- Amazon DynamoDB: document metadata persistence
- Amazon SNS: processing and duplicate-detection notifications

## Unique enhancement
Duplicate & Version Intelligence:
1. SHA-256 exact-content matching for exact duplicates.
2. Filename token similarity + file-size similarity for near-duplicate/version candidates.
3. Potential storage-savings estimate.
4. Human-readable recommendation/notification.

## Important
This is a browser-based AWS architecture simulation. It does not connect to a real AWS account and does not use AWS credentials.

## Run
Open `index.html` in a modern browser.

For the best demo:
1. Upload `assignment.pdf`.
2. Upload the exact same file again to demonstrate an exact duplicate.
3. Upload a renamed copy such as `assignment_final.pdf` with similar size/content to demonstrate a near-duplicate/version candidate.
4. Inspect Dashboard -> S3 -> EventBridge -> Lambda -> DynamoDB -> SNS -> Duplicate Detector.


## SNS notification demo

The top-right notification bell represents the user-facing SNS subscription in this simulation. Upload a document, then upload the exact same file again. Lambda detects the identical SHA-256 hash, the simulated SNS publisher creates a “Duplicate File Detected” alert, and the notification bell shows an unread count. Clicking the alert marks it read and opens the SNS Notification Center. In real AWS, SNS can deliver to subscribers such as email, SMS, HTTP/S endpoints, or other AWS services; this simulation represents that delivery as an in-app notification.
