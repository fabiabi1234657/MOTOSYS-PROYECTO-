package co.motosys.notify;

import static org.junit.jupiter.api.Assertions.*;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class ReportExecutorTest {
    @Test
    void runsFourReportsTogetherAndKeepsItsQueueBounded() throws Exception {
        var executor = new NotifyApplication().reportExecutor();
        executor.initialize();
        var started = new CountDownLatch(4);
        var release = new CountDownLatch(1);
        try {
            for (int task = 0; task < 4; task++) {
                executor.execute(() -> {
                    started.countDown();
                    try {
                        release.await(2, TimeUnit.SECONDS);
                    } catch (InterruptedException exception) {
                        Thread.currentThread().interrupt();
                    }
                });
            }
            assertTrue(started.await(2, TimeUnit.SECONDS));
            for (int task = 0; task < 50; task++) executor.execute(() -> {});
            assertEquals(50, executor.getThreadPoolExecutor().getQueue().size());
            assertEquals(8, executor.getMaxPoolSize());
        } finally {
            release.countDown();
            executor.shutdown();
        }
    }
}
