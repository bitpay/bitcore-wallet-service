FROM node

MAINTAINER Rick Moran <moran@crowbits.com>

RUN apt-get update && apt-get install -y --no-install-recommends \
    mongodb-clients \
  && rm -rf /var/lib/apt/lists/*

COPY . /bws

WORKDIR /bws

# I have no idea why I have to do this twice. 
# Perhaps some node loving individual can explain it to me.
RUN npm install;npm install

RUN sed 's/localhost:27017/bwsdb:27017/g' config.js > config.js.new; \
    mv config.js.new config.js

EXPOSE 3232 3231 3380 443

CMD npm start && tail -f logs/bws.log
