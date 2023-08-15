import { launch } from 'puppeteer';
import axios, { Axios, AxiosResponse } from 'axios';
import fs from 'fs';
import FormData from 'form-data';
const apiPath = "https://tuit.fr/api/"
interface Post {
	text: string,
	id: string,
	medias: string[],
	noteId?: string
}
interface User {
	posts: Post[],
	apiKey: string,
	visibility?: string
}
interface Database {
	[userId: string]: User
}
let database : Database = fs.existsSync("./data.json") ? JSON.parse(fs.readFileSync("./data.json").toString()) : {};
let i = 0;
let currentUserId = nextUserId();


function timeFuzz() {
    let num = Math.random() * 9 + 1;  // Generate a random number between 1 and 10
    return Math.round(num * 100) / 100;  // Round to 2 decimal places
}

async function uploadFiles(medias: string[], token: string){
	const endpoint = apiPath + "drive/files/create";
	let uploads: Promise<AxiosResponse<any>>[] = [];
	for(let media of medias) {
		console.log(`Uploading ${media}`);
		let file = await axios.get(media, {responseType: 'arraybuffer'});
		let formData = new FormData();
		// console.log(file.data.toString('ASCII'));
		formData.append('i', token);
		formData.append('file', file.data, {filename: media.split('/').pop()});
		formData.append('force', 'true');
		uploads.push(axios.post(endpoint, formData, { headers: { 'Content-Type': 'multipart/form-data' } }));
	}
	let results = await Promise.all(uploads);
	let ids = results.map((x) => x.data.id);
	console.log('uploaded files', ids);
	return ids;
}

async function postNote(tweet: Post, user: User) {
	const endpoint = apiPath + "notes/create";
	const uploadedFiles = await uploadFiles(tweet.medias, user.apiKey);
	return axios.post(endpoint, {
		'i': user.apiKey,
		visibility: user.visibility || "public",
		text: tweet.text,
		mediaIds: uploadedFiles})
}

function nextUserId() {
	let keys = Object.keys(database);
	if (i >= keys.length) i = 0;
	return keys[i++];
}
function deleteNote(note: Post, token: string) {
	const endpoint = apiPath + "notes/delete";
	axios.post(endpoint, {'i': token, noteId: note.noteId}).then((res) => {
		console.log(`Deleted note ${note.id}`)
	}).catch((err) => {
		console.log(err);
	})
}

function parsetweets(tweets: any) {
	let filtered : Post[] = [];
	for(let tweet of tweets) {
		let content = tweet.content;
		if (!tweet.entryId.startsWith('tweet')) continue;
		if (content.itemContent == undefined) continue;
		const legacy = content.itemContent.tweet_results.result.legacy
		if (legacy.is_quote_status == true) continue;
		if (legacy.full_text.startsWith('RT')) continue;
		console.log(legacy.full_text);
		let medias : string[] = [];
		for(let media of legacy.extended_entities.media) {
			if (media.type == 'photo')
				medias.push(media.media_url_https);
			else if (media.type == 'video') 
				medias.push(media.video_info.variants[0].url.split('?')[0]);
		}
		let res = {
			text : legacy.full_text.replace(/https:\/\/t.co\/\w+/, ''),
			id: legacy.id_str,
			medias: medias
		}
		filtered.push(res);
	}
	return filtered;
}

function extractUserId(url : string) {
    const decodedUrl = decodeURIComponent(url);
    const regex = /"userId"\s*:\s*"(\d+)"/;
    const match = decodedUrl.match(regex);
    return match ? match[1] : null;
}

(async () => {
  const browser = await launch({ headless: "new", args: ['--no-sandbox']});
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0")

  let cookies = JSON.parse(fs.readFileSync('./cookies.json').toString());

  await page.setCookie(...cookies);
	async function getTweets(){
		currentUserId = nextUserId();
		try{
			await page.goto('https://twitter.com/i/user/' + currentUserId, { waitUntil: 'networkidle2' });
		} catch(e) {
			console.log(e);
			return;
		}
		page.cookies().then((cookies) => {
			cookies = [cookies.find(x => x.name == 'auth_token')!, cookies.find(x => x.name == 'ct0')!]
			fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));
		})
		await new Promise(r => setTimeout(r, 1000 * (timeFuzz() + 15)));
	}
	// rate limit seems to be on graphql operations even if it looks like an api call limit
	await page.setRequestInterception(true);
	page.on('request', request => {
	  if (request.isInterceptResolutionHandled()) return;
	  const url = request.url();
	  if (url.includes('https://twitter.com/i/api/graphql/XicnWRbyQ3WgVY__VataBQ/UserTweets')){
    	let decodedUrl = decodeURIComponent(url);
		decodedUrl = decodedUrl.replace(/("count"\s*:\s*)\d+/, `$1${10}`);
		request.continue({ url: encodeURI(decodedUrl)});
	  }
	  else request.continue();
	});

  page.on('response', async response => {
	if (response.url().includes('https://twitter.com/i/api/graphql/XicnWRbyQ3WgVY__VataBQ/UserTweets')) {
		let userId = extractUserId(response.url()) as string;
		// fs.writeFileSync("./test.json", await response.text());
		console.log(`User ID: ${userId}`);
		let databasePosts = database[userId].posts;
		if (userId == null) return;
		let data = await response.json();
		let instructions = data.data.user.result.timeline_v2.timeline.instructions;
		let tweets = instructions[instructions.length - 1].entries;
		let todo = parsetweets(tweets);
		console.log(`${todo.length} tweets retrieved`)
		if(todo.length != 0) {
			let lastTweetId = todo[todo.length - 1].id;
			//remove untracked tweets
			database[userId].posts = databasePosts.filter(x => x.id >= lastTweetId);
		};
		let todelete = databasePosts.filter(x => todo.find((y) => (x.id == y.id) == undefined));
		let toadd = todo.filter(x => databasePosts.find((y) => x.id == y.id) == undefined);
		database[userId].posts = databasePosts.filter(x => todelete.find((y) => x.id == y.id) == undefined);
		for(let tweet of toadd) {
			postNote(tweet, database[userId]).then((res) => {
				console.log(`Posted tweet ${tweet.id}`)
				tweet.noteId = res.data.createdNote.id;
				database[userId].posts.push(tweet)
			}).catch(e => console.log(e));
		}
		for(let tweet of todelete) {
			deleteNote(tweet, database[userId].apiKey);
		}
		fs.writeFileSync("./data.json", JSON.stringify(database,null,2))
	}
});
while(1){
	await getTweets();
}
})();