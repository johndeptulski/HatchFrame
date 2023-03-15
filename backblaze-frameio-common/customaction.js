/*
MIT License

Copyright (c) 2022 Backblaze

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
 */

const createError = require("http-errors");
const crypto = require('crypto');
const {getFioAssets, createFioFolder, createFioAsset} = require("./frameio");
const {getB2Conn, streamToB2, createB2SignedUrls} = require("./b2");

const IMPORT = 'Import';
const EXPORT = 'Export';

function verifyTimestampAndSignature(req, res, buf, encoding) {
    // X-Frameio-Request-Timestamp header from incoming request
    const timestamp = req.header('X-Frameio-Request-Timestamp');
    // Epoch time in seconds
    const now = Date.now() / 1000;
    const FIVE_MINUTES = 5 * 60;

    if (!timestamp) {
        console.log('Missing timestamp')
        throw createError(403);
    }

    // Frame.io suggests verifying that the timestamp is within five minutes of local time
    if (timestamp < (now - FIVE_MINUTES) || timestamp > (now + FIVE_MINUTES)) {
        console.log(`Timestamp out of bounds. Timestamp: ${timestamp}; now: ${now}`);
        throw createError(403);
    }

    // Frame.io signature format is 'v0=' + HMAC-256(secret, 'v0:' + timestamp + body)
    const body = buf.toString(encoding);
    const stringToSign = 'v0:' + timestamp + ':' + body;
    const hmac = crypto.createHmac('sha256', process.env.FRAMEIO_SECRET);
    const expectedSignature = 'v0=' + hmac.update(stringToSign).digest('hex');

    if (expectedSignature !== req.header('X-Frameio-Signature')) {
        console.log(`Mismatched HMAC. Expecting '${expectedSignature}', received '${req.header('X-Frameio-Signature')}'`);
        throw createError(403);
    }
}

async function formProcessor(req, res, next) {
    // frame.io callback form logic
    let formResponse;

    try {
        let data = req.body.data;
        console.log(req.body);

        if (!data && req.body.type === "import-export") { // send user first question
            formResponse = {
                "title": "Import or Export?",
                "description": "Import from Backblaze B2, or export to Backblaze B2?",
                "fields": [{
                    "type": "select",
                    "label": "Import or Export",
                    "name": "copytype",
                    "options": [{
                        "name": "Export to Backblaze B2", "value": "export"
                    }, {
                        "name": "Import from Backblaze B2", "value": "import"
                    }]
                }]
            };
            return res.json(formResponse);
        }

        if ((!data && req.body.type === "export") || data['copytype'] === "export") {
            formResponse = {
                "title": "Specific Asset(s) or Whole Project?",
                "description": "Export the specific asset(s) selected or the entire project?",
                "fields": [{
                    "type": "select",
                    "label": "Specific Asset(s) or Entire Project",
                    "name": "depth",
                    "options": [{
                        "name": "Specific Asset(s)", "value": "asset"
                    }, {
                        "name": "Entire Project", "value": "project"
                    }]
                }]
            };
            return res.json(formResponse);
        } else if ((!data && req.body.type === "import") || data['copytype'] === "import") {
            // todo : possibly limit importing the export location
            formResponse = {
                "title": "Enter the location",
                "description": `Please enter the object path to import from Backblaze. As a reminder, your bucket name is ${process.env.BUCKET_NAME}. Only single files are currently supported.`,
                "fields": [{
                    "type": "text",
                    "label": "B2 Path",
                    "name": "b2path"
                }]
            };
            return res.json(formResponse);
        }

        next();
    } catch (err) {
        console.log('ERROR formProcessor: ', err, err.stack);
        throw new Error('ERROR formProcessor', err);
    }
}

async function createExportList(path, fileTree = '', depth = "asset") {
    // response may be one or more assets, depending on the path
    const assetList = await getFioAssets(path);

    console.log(`createExportList for ${path}, ${fileTree}, ${depth}, ${assetList.length}`);

    // If 'project' is selected, initiate a top level project recursion
    if (depth === 'project') {
        const asset = assetList[0];
        return createExportList(asset['project']['root_asset_id'] + '/children', asset['project']['name'] + '/');
    }

    const exportList = []
    for (const asset of assetList) {
        if (asset.type === 'version_stack' || asset.type === 'folder') {
            // handle nested folders and version stacks etc
            exportList.push(...await createExportList(asset.id + '/children', fileTree + asset.name + '/'));
        } else if (asset.type === 'file') {
            exportList.push({
                url: asset['original'],
                name: fileTree + asset.name,
                filesize: asset.filesize
            });
        } else {
            console.log('Asset? ', asset); // recursive 'if' above should prevent getting here
            return Promise.reject(new Error('error: unknown type ' + fileTree + '/' + asset.name));
        }
    }
    console.log('list done');

    return exportList;
}

async function exportFiles(request) {
    const exportList = await createExportList(request['resource']['id'], '', request['data']['depth']);

    const promises = []
    const b2 = getB2Conn();

    for (const entry of exportList) {
        promises.push(streamToB2(b2, entry.url, entry.name, entry.filesize));
    }

    const results = await Promise.allSettled(promises);

    const output = []
    for (let i = 0; i < exportList.length; i++) {
        output.push({...exportList[i], ...results[i]})
    }
    return output;
}

async function importFiles(req) {
    const b2 = getB2Conn();

    // We can create the signed URL at the same time as the download folder
    const promises = [];
    promises.push(createB2SignedUrls(b2, req.data['b2path']));
    promises.push(getFioAssets(req.resource.id).then((asset) => {
        const rootId = asset['project']['root_asset_id'];
        console.log('root:', rootId);
        return createFioFolder(rootId, process.env.DOWNLOAD_PATH);
    }));

    // remove exports folder name when re-importing
    let name = req.data['b2path'].replace(process.env.UPLOAD_PATH, '');
    if (name.startsWith('/')) {
        name = name.substr(1);
    }
    const output = await Promise.all(promises).then(async (values) => {
        const signedUrl = values[0];
        const parent = values[1];

        return createFioAsset(name, parent, signedUrl, req.filesize);
    });

    return {
        b2path: req.data['b2path'],
        id: req.resource.id,
        filesize: req.filesize,
        ...output
    };
}


module.exports = {
    verifyTimestampAndSignature,
    formProcessor,
    exportFiles,
    importFiles,
    IMPORT,
    EXPORT
};