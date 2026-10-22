#!/usr/bin/env bash
set -e
docker run --rm -v "$PWD":/src -w /src maven:3.5-jdk-8 mvn -DskipTests package
