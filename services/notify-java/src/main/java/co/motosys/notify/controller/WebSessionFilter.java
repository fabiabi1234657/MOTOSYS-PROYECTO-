package co.motosys.notify.controller;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class WebSessionFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String path = request.getServletPath();
        boolean clientRoute = path.equals("/notifications") || path.equals("/reminders")
                || path.startsWith("/documents/") || path.startsWith("/reports/");
        String session = cookie(request, "__Host-motosys");
        if (!clientRoute || request.getHeader("Authorization") != null || !valid(session)) {
            chain.doFilter(request, response);
            return;
        }
        if (!"GET".equals(request.getMethod()) && !"HEAD".equals(request.getMethod())) {
            String cookie = cookie(request, "__Host-motosys-csrf");
            String header = request.getHeader("X-CSRF-Token");
            if (!valid(cookie) || !valid(header) || !MessageDigest.isEqual(
                    cookie.getBytes(StandardCharsets.US_ASCII), header.getBytes(StandardCharsets.US_ASCII))) {
                response.sendError(403, "Validación CSRF fallida.");
                return;
            }
        }
        var wrapper = new HttpServletRequestWrapper(request) {
            @Override
            public String getHeader(String name) {
                return "Authorization".equalsIgnoreCase(name) ? "Bearer " + session : super.getHeader(name);
            }
            @Override
            public java.util.Enumeration<String> getHeaders(String name) {
                return "Authorization".equalsIgnoreCase(name)
                        ? Collections.enumeration(java.util.List.of("Bearer " + session)) : super.getHeaders(name);
            }
        };
        chain.doFilter(wrapper, response);
    }

    private static boolean valid(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{43}");
    }
    private static String cookie(HttpServletRequest request, String name) {
        if (request.getCookies() != null) {
            for (Cookie cookie : request.getCookies()) {
                if (cookie.getName().equals(name)) return cookie.getValue();
            }
        }
        return null;
    }
}
