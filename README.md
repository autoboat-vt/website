# Website for Virginia Tech's AutoBoat team

This website is written in raw HTML, JS, and CSS.

## File Layout

-   `index.html`: Main **about** page
-   `html` folder: Contains the html source for all the auxiliary pages (e.g., meet the team)
-   `css` folder: Styling for the overall website

## Running for Development

There are two main ways to run this website if you are developing and would like to test changes locally: through VSCode and through Python.

### VS Code

Use the live server plugin and open the folder with it

### Python

Run `python -m http.server` in this folder. You might need to use `python3` instead of `python` on Linux/MacOS.


<br>


## Deploying the Website

The website is hosted via Virginia Tech's site hosting platform, and because of this all we really need to do is push to a specific Github repository. However, to get access to the Github repository, we need to put in a help ticket to the Virginia Tech site hosting platform, so please contact the Software Officer for more information. Once you have access, then run the following commands to set the remote up. You only need to run this command once.

```git remote add aoe_sites https://code.vt.edu/s4-hosting-sites/aoe/sailbot```


<br>


Finally, to deploy the website, run the following commands:

```git push origin main```

```git push aoe_sites main```