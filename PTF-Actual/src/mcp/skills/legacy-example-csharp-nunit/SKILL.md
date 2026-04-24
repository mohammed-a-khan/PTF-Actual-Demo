---
name: legacy-example-csharp-nunit
description: Reference — a representative C# + NUnit test class + page object. Agents pattern-match against this when parsing similar legacy files.
---

# Reference: typical C# + NUnit legacy test

Use this skill when `legacy_parse` encounters a C# + NUnit source file.

## Typical test class

```csharp
using NUnit.Framework;
using OpenQA.Selenium;
using Example.Pages;

namespace Example.Tests
{
    [TestFixture]
    public class LoginTests : BaseTest
    {
        private LoginPage loginPage;
        private DashboardPage dashboardPage;

        [SetUp]
        public void SetUp()
        {
            loginPage = new LoginPage(driver);
            dashboardPage = new DashboardPage(driver);
        }

        [Test]
        [TestCase("alice@example.com", "Welcome, Alice")]
        [TestCase("bob@example.com",   "Welcome, Bob")]
        public void LoginSuccessTest(string userName, string expectedHeader)
        {
            driver.Navigate().GoToUrl("https://app.example.com/login");
            loginPage.EnterUserName(userName);
            loginPage.EnterPassword("ENC:passwd");
            loginPage.ClickSignIn();

            var header = dashboardPage.GetWelcomeHeader();
            Assert.AreEqual(expectedHeader, header);
        }
    }
}
```

## Typical page object

```csharp
using OpenQA.Selenium;
using OpenQA.Selenium.Support.PageObjects;

namespace Example.Pages
{
    public class LoginPage
    {
        [FindsBy(How = How.Id, Using = "userId")]
        private IWebElement userIdField;

        [FindsBy(How = How.Id, Using = "password")]
        private IWebElement passwordField;

        [FindsBy(How = How.XPath, Using = "//button[@id='signin-btn']")]
        private IWebElement signInButton;

        public LoginPage(IWebDriver driver) { PageFactory.InitElements(driver, this); }

        public void EnterUserName(string userName) { userIdField.SendKeys(userName); }
        public void EnterPassword(string password) { passwordField.SendKeys(password); }
        public void ClickSignIn() { signInButton.Click(); }
    }
}
```

## What `legacy_parse` extracts

- **Runner**: detected as `nunit` from `using NUnit.Framework`
- **Tests**: `LoginSuccessTest` with its `[TestCase]` rows becoming `data_refs` (inlined)
- **Steps**: navigate, fill, fill, click, assert
- **Page objects**: same as Java — `[FindsBy]` translates to the IR element list
- **DB ops**: if any inline `new SqlCommand("SELECT ...")` constructions, they go to `extract_db_calls`

## Variations

- `[Fact]` instead of `[Test]` → xUnit runner
- `[Theory]` with `[InlineData]` → data-provider equivalent
- `WebDriverWait` usage → translates to `waitForVisible` in IR steps
- Ginq/LINQ assertions (`Assert.That(x, Is.EqualTo(y))`) → same assert_equals semantics
