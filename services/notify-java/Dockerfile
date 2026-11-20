FROM maven:3.9.12-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml ./
RUN mvn -B dependency:go-offline
COPY src ./src
RUN mvn -B package

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
COPY --from=build --chown=10001:10001 /src/target/notify-java.jar ./notify.jar
ENV JAVA_TOOL_OPTIONS="-Xms32m -Xmx256m -XX:ActiveProcessorCount=2 -XX:MaxMetaspaceSize=96m"
RUN apt-get update -q && apt-get install -y --no-install-recommends curl fontconfig fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
USER 10001:10001
EXPOSE 3001
ENTRYPOINT ["java", "-jar", "/app/notify.jar"]
