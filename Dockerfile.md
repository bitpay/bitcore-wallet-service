# Run BWS under docker

## Build the docker

To build the container, you do something like:

docker build -t [YOUR DOCKER USER]/bitcore-wallet-service:[THE CONTAINER VERSION] .

A concrete example of which is:

docker build -t drhayt/bitcore-wallet-service:latest .

## Run the container

Going over all the methods to run and manage docker containers is far beyond the scope of this document.

What is important is that you understand what the docker container provides when it is run, and what the expectations of the built docker container.  The expectations are:

1.  MongoDB
 1. The Container expects there to be a mongodb intance somewhere.
 1. The name of the expected mongodb instance is ___bwsdb___
 1. The mongodb port is expected to be 27017.
 1. The mongodb connection is unauthenticated.

The container provides:

1.  NO PUBLIC ACCESS
 1.  Unless you map ports on the docker run commandline, no ports will be exposed.

## Run Examples
### Dockerized MongoDB on the same Docker host

docker run --name bwsdb  -v /mongodb/data/db:/data/db -d mongo:latest

docker run --name bws -p 3232:3232 --link bwsdb:bwsdb -d bitcore-wallet-service

### An external mongodb

docker run --name bws -p 3232:3232 --add-host bwsdb:1.2.3.4  -d bitcore-wallet-service
