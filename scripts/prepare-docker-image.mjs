import { prepareDockerImage, dockerImage } from "../src-tauri/runtime/docker-image.mjs";
console.log(`Preparing ${dockerImage.image} from the bundled recipe. First build needs Docker and Debian network access.`);
console.log(JSON.stringify(await prepareDockerImage(), null, 2));
