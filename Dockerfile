FROM node:18

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY . .
RUN npm install

# Bundle app source
CMD [ "npm", "start" ]