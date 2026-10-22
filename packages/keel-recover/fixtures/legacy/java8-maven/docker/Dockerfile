FROM maven:3.6-jdk-8 AS build
COPY . /src
RUN mvn -q -DskipTests package

FROM openjdk:8-jre
COPY --from=build /src/target/inventory-service.jar /app.jar
ENTRYPOINT ["java", "-jar", "/app.jar"]
