var fs = require("fs");
var path = require("path");
var glob = require("glob");
var async = require("async");
var mime = require("mime");
var debug = require("debug")("deploy-static-site");

// # of network requests
var MAX_PARALLEL = 25;

/**
 * Translate paths into a more usable format.
 * @param rootPath The path used as the root dir during discovery.
 * @param localPath The absolute path to be uploaded.
 * @param done
 * */
function makeLocalTask (rootPath, localPath, done) {
    fs.lstat(localPath, function(err, stat){
        // S3 doesn't have the concept of directories
        if (!stat.isFile()) return done(null, undefined);
        done(null, {
            type: "file",
            localPath: localPath,
            remotePath: path.relative(rootPath, localPath)
        });
    });
}

/**
 * Search the target directory and translate them into a set of actions for us to perform.
 * @param rootPath The path to get tasks for
 * @param searchPattern The pattern to search for within the root path.
 * @param done
 * */
function buildLocalExecutionPlan (rootPath, searchPattern, done) {
    var globPath = path.format({ dir: rootPath, base: searchPattern || "**" });
    debug("Discovering files...");
    glob(globPath, function(err, paths) {
        if (err) return done(err);
        // Enumerate all files and create tasks
        async.mapLimit(paths, MAX_PARALLEL, makeLocalTask.bind(null, rootPath), done);
    });
}

/**
 * Execute the inputted task on S3 and correctly configures files to be presented.
 * @param s3 The configured S3 object from AWS SDK.
 * @param bucketName The name of the bucket to upload to.
 * @param task The task object to execute.
 * @param done
 * */
function executeTaskOnS3 (s3, bucketName, task, done)  {
    if (!task || task.remotePath === "") return done(); // Ignore root

    // Upload the file to S3
    var mime = mime.lookup(task.localPath);
    s3.upload({
        Bucket: bucketName,
        Key: task.remotePath,
        ACL: "public-read",
        ContentType: mime,
        Body: fs.createReadStream(task.localPath)
    }, function (err) {
        if (err) return done(err);
        debug("Uploading '" + task.localPath + "' of '" + mime +"' to '" + bucketName + "' at '" + task.remotePath + "'");
        done();
    });
}

/**
 * Builds a policy statement that makes a S3 bucket publicly readable.
 * @param bucketName The name of the bucket to make public.
 * */
function createAnonReadStatement (bucketName) {
    return {
        Version: "2012-10-17",
        Statement: [
            {
                Sid: "AddPerm",
                Effect: "Allow",
                Principal: "*",
                Action: [
                    "s3:GetObject"
                ],
                Resource: [
                    "arn:aws:s3:::" + bucketName + "/*",
                    "arn:aws:s3:::" + bucketName + "/**/*"
                ]
            }
        ]
    }
}

/**
 * Creates a full policy which will make a bucket publicly readable.
 * @param bucketName The name of the bucket to make public.
 * @returns {{Bucket: *, Policy}}
 */
function createAnonReadPolicy (bucketName) {
    return {
        Bucket: bucketName,
        Policy: JSON.stringify(createAnonReadStatement(bucketName))
    }
}

/**
 * Configures a S3 bucket to be public.
 * @param s3 The authenticated S3 object from AWS SDK.
 * @param bucketName The name of the bucket to use.
 * @param done
 */
function configureWebsiteBucket(s3, bucketName, done) {
    s3.putBucketPolicy(createAnonReadPolicy(bucketName), function(err) {
        if (err) return done(err);
        debug("Made Bucket '" + bucketName +"' readable");
        // TODO: Configure bucket as website
        done(null);
    });
}

/**
 * Uploads all applicable files in a directory to a S3 bucket using the specified search path.
 * @param rootPath The directory to upload from.
 * @param dirSearchPattern The file search pattern to execute, defaults to all.
 * @param s3 The authenticated S3 Object from AWS SDK.
 * @param bucketName The name of the bucket to upload to.
 * @param done
 */
function uploadDirToS3 (rootPath, dirSearchPattern, s3, bucketName, done) {
    buildLocalExecutionPlan(rootPath, dirSearchPattern, function (err, tasks) {
        if (err) return done(err);
        debug("Discovered " + tasks.length + " files...");
        debug("Uploading files Bucket '" + bucketName + "'");
        // TODO: Discover delta and delete old files
        async.eachLimit(tasks, MAX_PARALLEL, executeTaskOnS3.bind(null, s3, bucketName), done);
    });
}

/**
 * Configures the bucket as a website and uploads all applicable files in a directory to a S3 bucket using the specified search path..
 * @param rootPath The directory to upload from.
 * @param dirSearchPattern The file search pattern to execute, defaults to all.
 * @param s3 The authenticated S3 Object from AWS SDK.
 * @param bucketName The name of the bucket to upload to.
 * @param done
 */
function s3WebsiteFromDirectory (rootPath, dirSearchPattern, s3, bucketName, done) {
    configureWebsiteBucket(s3, bucketName, function (err, siteURL) {
        if (err) return done(err);
        uploadDirToS3(rootPath, dirSearchPattern, s3, bucketName, function (err) {
            if (err) return done(err);
            debug("SUCCESS: Finished Uploading files...");
        });
    });
}

module.exports = {
    s3WebsiteFromDirectory: s3WebsiteFromDirectory
    configureWebsiteBucket: configureWebsiteBucket,
    uploadDirToS3: uploadDirToS3,

    buildLocalExecutionPlan: buildLocalExecutionPlan
    executeTaskOnS3: executeTaskOnS3
};
