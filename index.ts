import { launch } from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
const apiPath = "https://tuit.fr"
interface Post {
	text: string,
	id: string,
	noteId?: string
}
interface User {
	posts: Post[],
	apiKey: string
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

function postNote(tweet: Post, token: string, userId: string) {
	const endpoint = apiPath + "/api/notes/create";
	axios.post(endpoint, {'i': token, text: tweet.text}).then((res) => {
		console.log(`Posted tweet ${tweet.id}`)
		tweet.noteId = res.data.createdNote.id;
		database[userId].posts.push(tweet);
	}).catch((err) => {
		console.log(err);
	})
}

function nextUserId() {
	let keys = Object.keys(database);
	if (i >= keys.length) i = 0;
	return keys[i++];
}
function deleteNote(note: Post, token: string, userId: string) {
	const endpoint = apiPath + "/api/notes/delete";
	axios.post(endpoint, {'i': token, noteId: note.noteId}).then((res) => {
		console.log(`Deleted note ${note.id}`)
		console.log(res.data);
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
		if (content.itemContent.tweet_results.result.legacy.is_quote_status == true) continue;
		if (content.itemContent.tweet_results.result.legacy.full_text.startsWith('RT')) continue;
		console.log(content.itemContent.tweet_results.result.legacy.full_text);
		let res = {
			text : content.itemContent.tweet_results.result.legacy.full_text,
			id: content.itemContent.tweet_results.result.legacy.id_str
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
		await new Promise(r => setTimeout(r, 1000 * (timeFuzz() + 5)));
	}


  page.on('response', async response => {
	if (response.url().includes('https://twitter.com/i/api/graphql/XicnWRbyQ3WgVY__VataBQ/UserTweets')) {
		let userId = extractUserId(response.url()) as string;
		fs.writeFileSync("./test.json", JSON.stringify(await response.json(),null,2))
		console.log(`User ID: ${userId}`);
		let databasePosts = database[userId].posts;
		if (userId == null) return;
		let data = await response.json();
		let instructions = data.data.user.result.timeline_v2.timeline.instructions;
		let tweets = instructions[instructions.length - 1].entries;
		let todo = parsetweets(tweets);
		console.log(`${todo.length} tweets retrieved`)
		let lastTweetId = todo[todo.length - 1].id;
		let todelete = databasePosts.filter(x => (+x.id >= +lastTweetId && todo.find((y) => (x.id == y.id) == undefined)));
		let toadd = todo.filter(x => databasePosts.find((y) => x.id == y.id) == undefined);
		databasePosts = databasePosts.filter(x => todelete.find((y) => x.id == y.id) == undefined);
		for(let tweet of toadd) {
			postNote(tweet, database[userId].apiKey, userId);
		}
		for(let tweet of todelete) {
			deleteNote(tweet, database[userId].apiKey, userId);
		}
		fs.writeFileSync("./data.json", JSON.stringify(database,null,2))
	}
});
while(1){
	await getTweets();
}
})();
