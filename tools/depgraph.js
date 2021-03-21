import crypto from "crypto";
import { promises as fs } from "fs";
import process from "process";
import url from "url";

import { Command } from "commander";

import { getTestHash } from "../lib/hash-test.js";
import {
  getLangs,
  getSharedDeps,
  getSharedDepsForLangConfig,
  readLangConfig,
} from "../lib/yaml.js";
import {
  getDockerRepo,
  getLocalImageLabel,
  getRemoteImageLabel,
} from "./docker-util.js";
import { getBaseImages, hashDockerfile } from "./hash-dockerfile.js";
import { runCommand } from "./util.js";

function getS3Bucket() {
  if (!process.env.S3_BUCKET) {
    throw new Error(`unset environment variable: \$S3_BUCKET`);
  }
  return process.env.S3_BUCKET;
}

function getInformationalDependencies() {
  return {
    s3DebHashes: async () => {
      return Object.fromEntries(
        JSON.parse(
          (
            await runCommand(
              `aws s3api list-objects-v2 --bucket riju-debs --prefix hashes`,
              { getStdout: true }
            )
          ).stdout
        ).Contents.map(({ Key: key }) => {
          const [_, remoteName, remoteHash] = key.split("/");
          return [remoteName, remoteHash];
        })
      );
    },
    s3TestHashes: async () => {
      return Object.fromEntries(
        JSON.parse(
          (
            await runCommand(
              `aws s3api list-objects-v2 --bucket riju-debs --prefix test-hashes/lang`,
              { getStdout: true }
            )
          ).stdout
        ).Contents.map(({ Key: key }) => {
          const [_1, _2, remoteName, remoteHash] = key.split("/");
          return [remoteName, remoteHash];
        })
      );
    },
  };
}

async function getImageArtifact({ tag, isBaseImage, isLangImage }) {
  const DOCKER_REPO = getDockerRepo();
  const name = isLangImage ? "lang" : tag;
  let baseImageTags = [];
  let dependencies = [];
  if (!isBaseImage) {
    baseImageTags = [...new Set(await getBaseImages(name))].map((baseImage) => {
      if (!baseImage.startsWith("riju:")) {
        throw new Error(
          `non-Riju base image '${baseImage}' in Dockerfile for ${name} image`
        );
      }
      return baseImage.replace(/^riju:/, "");
    });
    dependencies = baseImageTags.map(
      (baseImageName) => `image:${baseImageTag}`
    );
  }
  if (isLangImage) {
    dependencies.push(`deb:lang-${isLangImage.lang}`);
    dependencies.concat(
      isLangImage.sharedDeps.map((name) => `deb:shared-${name}`)
    );
  }
  return {
    name: `image:${tag}`,
    dependencies: dependencies,
    getLocalHash: async () => {
      return await getLocalImageLabel(`riju:${tag}`, "riju.image-hash");
    },
    getPublishedHash: async () => {
      return await getRemoteImageLabel(
        `${DOCKER_REPO}:${tag}`,
        "riju.image-hash"
      );
    },
    getDesiredHash: async (dependencyHashes) => {
      if (isBaseImage) {
        return null;
      }
      const dependentDockerHashes = {};
      for (const baseImageTag of baseImageTag) {
        dependentDockerHashes[`riju:${baseImageTag}`] =
          dependencyHashes[`image:${baseImageTag}`];
      }
      const salt = null;
      if (isLangImage) {
        salt.langHash = dependencyHashes[`deb:lang-${isLangImage.lang}`];
        salt.sharedHashes = isLangImage.sharedDeps.map(
          (name) => dependencyHashes[`deb:shared-${name}`]
        );
      }
      return await hashDockerfile(name, dependentDockerHashes, { salt });
    },
    buildLocally: async () => {
      await runCommand(`make image I=${tag}`);
    },
    retrieveFromRegistry: async () => {
      await runCommand(`make pull I=${tag}`);
    },
    publishToRegistry: async () => {
      await runCommand(`make push I=${tag}`);
    },
  };
}

async function getDebArtifact({ type, lang }) {
  return {
    name: `deb:${type}-${lang}`,
    dependencies: ["image:packaging"],
    informationalDependencies: {
      getPublishedHash: "s3DebHashes",
    },
    getLocalHash: async () => {
      try {
        await fs.access(debPath);
      } catch (err) {
        return null;
      }
      return (
        (
          await runCommand(`dpkg-deb -f ${debPath} Riju-Script-Hash`, {
            getStdout: true,
          })
        ).stdout.trim() || null
      );
    },
    getPublishedHash: async ({ s3DebHashes }) => {
      return s3DebHashes[`riju-${type}-${lang}`] || null;
    },
    getDesiredHash: async () => {
      let contents = await fs.readFile(
        `build/${type}/${lang}/build.bash`,
        "utf-8"
      );
      contents +=
        (await getLocalImageLabel("riju:packaging", "riju.image-hash")) + "\n";
      return crypto.createHash("sha1").update(contents).digest("hex");
    },
    buildLocally: async () => {
      await runCommand(
        `make shell I=packaging CMD="make pkg T=${type} L=${lang}"`
      );
    },
    retrieveFromRegistry: async () => {
      await runCommand(`make download T=${type} L=${lang}`);
    },
    publishToRegistry: async () => {
      await runCommand(`make upload T=${type} L=${lang}`);
    },
  };
}

async function getLanguageTestArtifact({ lang }) {
  return {
    name: `test:lang-${lang}`,
    dependencies: ["image:runtime"],
    informationalDependencies: {
      getPublishedHash: "s3TestHashes",
      retrieveFromRegistry: "s3TestHashes",
    },
    getLocalHash: async () => {
      const hashPath = `build/test-hashes/lang/${lang}`;
      let hash;
      try {
        return (await fs.readFile(hashPath, "utf-8")).trim();
      } catch (err) {
        if (err.code === "ENOENT") {
          return null;
        } else {
          throw err;
        }
      }
    },
    getPublishedHash: async ({ s3TestHashes }) => {
      return s3TestHashes[lang];
    },
    getDesiredHash: async () => {
      return await getTestHash(lang);
    },
    buildLocally: async () => {
      await runCommand(`make shell I=runtime CMD="make test L=${lang}"`);
    },
    retrieveFromRegistry: async ({ s3TestHashes }) => {
      await fs.writeFile(
        `build/test-hashes/lang/${lang}`,
        s3TestHashes[lang] + "\n"
      );
    },
    publishToRegistry: async () => {
      const hashPath = `build/test-hashes/lang/${lang}`;
      const hash = (await fs.readFile(hashPath, "utf-8")).trim();
      const S3_BUCKET = getS3Bucket();
      await runCommand(
        `aws s3 cp ${hashPath} s3://${S3_BUCKET}/test-hashes/lang/${lang}/${hash}`
      );
    },
  };
}

async function getDeployArtifact(langs) {
  return {
    name: `deploy:prod`,
    dependencies: ["image:app"]
      .concat(langs.map((lang) => `image:lang-${lang}`))
      .concat(langs.map((lang) => `test:lang-${lang}`)),
    getLocalHash: async () => {
      return null;
    },
  };
}

async function getDepGraph() {
  const informationalDependencies = getInformationalDependencies();
  const artifacts = [];
  artifacts.push(
    await getImageArtifact({
      tag: "ubuntu",
      isBaseImage: true,
    })
  );
  artifacts.push(await getImageArtifact({ tag: "packaging" }));
  artifacts.push(await getImageArtifact({ tag: "base" }));
  for (const sharedDep of await getSharedDeps()) {
    artifacts.push(await getDebArtifact({ type: "shared", lang: sharedDep }));
  }
  const langs = await getLangs();
  const langConfigs = Object.fromEntries(
    await Promise.all(
      langs.map(async (lang) => [lang, await readLangConfig(lang)])
    )
  );
  artifacts.push(await getImageArtifact({ tag: "runtime" }));
  for (const lang of langs) {
    artifacts.push(await getDebArtifact({ type: "lang", lang: lang }));
    artifacts.push(
      await getImageArtifact({
        tag: `lang-${lang}`,
        isLangImage: {
          lang: lang,
          sharedDeps: await getSharedDepsForLangConfig(langConfigs[lang]),
        },
      })
    );
    artifacts.push(await getLanguageTestArtifact({ lang: lang }));
  }
  artifacts.push(await getImageArtifact({ tag: "app" }));
  artifacts.push(await getDeployArtifact(langs));
  return { informationalDependencies, artifacts };
}

async function main() {
  const program = new Command();
  program.usage("<target>...");
  program.option("--list", "list available artifacts; ignore other arguments");
  program.option("--publish", "publish artifacts to remote registries");
  program.option("--yes", "execute plan without confirmation");
  program.parse(process.argv);
  const { list, publish, yes } = program.opts();
  const depgraph = await getDepGraph();
  if (list) {
    for (const { name } of depgraph.artifacts) {
      console.log(name);
    }
    console.error();
    console.error(`${depgraph.artifacts.length} artifacts`);
    process.exit(0);
  }
  if (program.args.length === 0) {
    program.help({ error: true });
  }
  console.log("doing things now");
}

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}