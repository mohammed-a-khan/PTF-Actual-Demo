---
name: legacy-example-java-testng
description: Reference — a representative Java + TestNG test class + page object. Agents pattern-match against this when parsing similar legacy files.
---

# Reference: typical Java + TestNG legacy test

Use this skill when `legacy_parse` encounters a Java + TestNG source file and the agent needs to sanity-check the parsed IR against the shape of real-world legacy code.

## Typical test class

```java
package com.example.tests;

import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;
import org.testng.annotations.DataProvider;
import org.openqa.selenium.WebDriver;
import com.example.pages.LoginPage;
import com.example.pages.DashboardPage;

public class LoginTest extends BaseTest {

    private LoginPage loginPage;
    private DashboardPage dashboardPage;

    @BeforeMethod
    public void setUp() {
        loginPage = new LoginPage(driver);
        dashboardPage = new DashboardPage(driver);
    }

    @DataProvider(name = "users")
    public Object[][] provideUsers() {
        return new Object[][] {
            { "alice@example.com", "Welcome, Alice" },
            { "bob@example.com",   "Welcome, Bob" }
        };
    }

    @Test(dataProvider = "users")
    public void loginSuccessTest(String userName, String expectedHeader) {
        driver.get("https://app.example.com/login");
        loginPage.enterUserName(userName);
        loginPage.enterPassword("ENC:passwd");
        loginPage.clickSignIn();

        String header = dashboardPage.getWelcomeHeader();
        assertEquals(expectedHeader, header);
    }

    @Test
    public void lockedAccountTest() {
        String sql = "SELECT LOCK_STATUS FROM USERS WHERE EMAIL = '" + "locked@example.com" + "'";
        // ...
    }
}
```

## Typical page object

```java
package com.example.pages;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.FindBy;
import org.openqa.selenium.support.PageFactory;

public class LoginPage {

    @FindBy(id = "userId")
    private WebElement userIdField;

    @FindBy(id = "password")
    private WebElement passwordField;

    @FindBy(xpath = "//button[@id='signin-btn']")
    private WebElement signInButton;

    public LoginPage(WebDriver driver) { PageFactory.initElements(driver, this); }

    public void enterUserName(String userName) { userIdField.sendKeys(userName); }
    public void enterPassword(String password) { passwordField.sendKeys(password); }
    public void clickSignIn() { signInButton.click(); }
}
```

## What `legacy_parse` extracts

- **Tests**: `loginSuccessTest`, `lockedAccountTest` (each with step sequence: navigate, fill, fill, click, assert)
- **Data refs**: the `@DataProvider` method — inlined rows (in this case)
- **Page objects**: `LoginPage` with elements `userIdField` (id=userId), `passwordField` (id=password), `signInButton` (xpath=…)
- **DB ops**: the inline SELECT in `lockedAccountTest` — goes to `extract_db_calls` for migration

## Variations seen in the wild

- `@FindBy(css = ...)` in place of `@FindBy(xpath = ...)`
- `@BeforeClass` instead of `@BeforeMethod`
- `@Test(groups = {...})` — treat as tag metadata
- Inline locators: `driver.findElement(By.id("userId"))` — extract as a dynamic locator in IR
