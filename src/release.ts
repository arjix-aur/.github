import { Writable } from "node:stream";
import { Octokit } from "octokit";
import "zx/globals";

const org = "arjix-aur";
const owner = org;

const octokit = new Octokit({ auth: process.env.TOKEN });
const repos = await octokit.rest.repos.listForOrg({ org });

const packages = repos.data.filter(({ topics }) => topics?.includes("pkg"));

if (packages.length === 0) {
    console.error("No packages found.");
    process.exit(0);
}

let latestRelease;
try {
    latestRelease = await octokit.rest.repos.getReleaseByTag({
        owner,
        repo: ".github",
        tag: "latest",
    });
} catch (error) {
    console.log("Latest release not found, creating a new one.");
    latestRelease = await octokit.rest.repos.createRelease({
        owner,
        repo: ".github",
        tag_name: "latest",
        name: "Latest",
        body: "Automated release of prebuilt packages",
        draft: false,
        prerelease: false,
    });
}

const release_id = latestRelease.data.id;
let remoteAssetNames = latestRelease.data.assets.map((asset) => asset.name);

const allAssets = [];
for (const { name: repo } of packages) {
    const { status, data: releases } = await octokit.rest.repos.listReleases({
        owner,
        repo,
    });

    if (status !== 200) {
        console.error(`Failed to list releases for ${owner}/${repo}`);
        continue;
    }

    const assets = releases.flatMap(({ assets }) => assets);
    for (const _ of assets) {
        console.log(" ==> Found", _.name);
        allAssets.push(_);
    }
}

const localAssetNames = allAssets.map((asset) => asset.name);



await $`rm -rf assets`;
await $`mkdir assets`;

for (const asset of allAssets) {
    console.log(" ==> Downloading", asset.name);

    const { data: stream } = await octokit.request<ReadableStream<Uint8Array>>({
        url: asset.browser_download_url,
        mediaType: {
            format: "raw",
        },
        request: {
            parseSuccessResponseBody: false,
        },
    });

    const fileStream = fs.createWriteStream(path.resolve("assets", asset.name));
    await stream.pipeTo(Writable.toWeb(fileStream));
}

cd("assets");
await $`find . -name '*.pkg.tar.zst' | sort | xargs repo-add --include-sigs arjix-aur.db.tar.gz`;
{
    await fs.remove("arjix-aur.db");
    await fs.remove("arjix-aur.files");

    await fs.rename("arjix-aur.db.tar.gz", "arjix-aur.db");
    await fs.rename("arjix-aur.files.tar.gz", "arjix-aur.files");
}

const currentLocalAssetNames = await fs.readdir(".");

// Delete remote assets that are not in local assets
for (const remoteAssetName of remoteAssetNames) {
    if (!currentLocalAssetNames.includes(remoteAssetName)) {
        console.log(" ==> Deleting remote asset", remoteAssetName);
        const assetToDelete = latestRelease.data.assets.find(
            (asset) => asset.name === remoteAssetName
        );
        if (assetToDelete) {
            await octokit.rest.repos.deleteReleaseAsset({
                owner,
                repo: ".github",
                asset_id: assetToDelete.id,
            });
        }
    }
}

// Upload local assets that are not in remote assets
for (const localAssetName of currentLocalAssetNames) {
    if (localAssetName.startsWith("arjix-aur") && !remoteAssetNames.includes(localAssetName)) {
        console.log(" ==> Uploading", localAssetName);
        await octokit.rest.repos.uploadReleaseAsset({
            owner,
            repo: ".github",
            release_id: release_id,
            name: localAssetName,
            data: await fs.readFile(localAssetName) as any,
        });
    }
}
